import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const app = express()
const PORT = Number(process.env.PORT || 43123)
const HOST = process.env.HOST || '0.0.0.0'
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || ''
const sessionTokens = new Map()
const PUBLIC_FORWARD_SERVICE = 'warp-socks5-public.service'
const PUBLIC_FORWARD_SERVICE_PATH = '/etc/systemd/system/warp-socks5-public.service'
const WARP_SERVICE = 'warp-svc'
const STATIC_DIR = path.join(process.cwd(), 'public')

app.use(express.json({ limit: '1mb' }))
app.use(express.static(STATIC_DIR))

function ok(res, data = {}) {
  res.json({ ok: true, ...data })
}

function fail(res, error, status = 500, extra = {}) {
  res.status(status).json({ ok: false, error: String(error), ...extra })
}

async function run(cmd, args = [], options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: options.timeout ?? 30000,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      shell: false,
      env: { ...process.env, ...(options.env || {}) },
      cwd: options.cwd || process.cwd(),
    })
    return { stdout: stdout?.trim?.() ?? '', stderr: stderr?.trim?.() ?? '' }
  } catch (error) {
    const stdout = error.stdout?.toString?.().trim?.() || ''
    const stderr = error.stderr?.toString?.().trim?.() || error.message || String(error)
    throw new Error([stderr, stdout].filter(Boolean).join('\n'))
  }
}

async function maybeRun(cmd, args = [], options = {}) {
  try {
    return await run(cmd, args, options)
  } catch (error) {
    return { stdout: '', stderr: String(error.message || error), error: String(error.message || error) }
  }
}

function requireAuth(req, res, next) {
  if (!PANEL_PASSWORD) return next()
  const token = req.get('x-panel-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token || !sessionTokens.has(token)) {
    return fail(res, 'Unauthorized', 401)
  }
  next()
}

function parseWarpSettings(raw) {
  const mode = raw.match(/Mode:\s+(.+)/)?.[1]?.trim() || ''
  const proxyPort = Number(raw.match(/WarpProxy on port\s+(\d+)/)?.[1] || 0) || null
  const protocol = raw.match(/WARP tunnel protocol:\s+(.+)/)?.[1]?.trim() || ''
  return { mode, proxyPort, protocol, raw }
}

function parsePublicForwardService(text) {
  const match = text.match(/TCP-LISTEN:(\d+),bind=([^,]+),reuseaddr,fork\s+TCP:([^:]+):(\d+)/)
  if (!match) return null
  return {
    publicPort: Number(match[1]),
    bindHost: match[2],
    targetHost: match[3],
    targetPort: Number(match[4]),
    raw: text,
  }
}

async function getServiceState(name) {
  const active = await maybeRun('systemctl', ['is-active', name])
  const enabled = await maybeRun('systemctl', ['is-enabled', name])
  return {
    name,
    active: active.stdout || active.stderr,
    enabled: enabled.stdout || enabled.stderr,
  }
}

async function getPublicForwardConfig() {
  try {
    const raw = await fs.readFile(PUBLIC_FORWARD_SERVICE_PATH, 'utf8')
    return parsePublicForwardService(raw)
  } catch {
    return null
  }
}

async function getIpViaCurl(proxyPort) {
  const args = ['-sS', '--max-time', '15']
  if (proxyPort) {
    args.push('-x', `socks5h://127.0.0.1:${proxyPort}`)
  }
  args.push('https://icanhazip.com')
  const result = await maybeRun('curl', args)
  return (result.stdout || '').trim()
}

async function getTrace(proxyPort) {
  const args = ['-sS', '--max-time', '20']
  if (proxyPort) {
    args.push('-x', `socks5h://127.0.0.1:${proxyPort}`)
  }
  args.push('https://www.cloudflare.com/cdn-cgi/trace')
  const result = await maybeRun('curl', args)
  return result.stdout || result.stderr || ''
}

async function getOverview() {
  const [warpStatus, warpSettings, warpAccount, warpService, publicForwardService, listeners, publicForwardConfig] = await Promise.all([
    maybeRun('warp-cli', ['--accept-tos', 'status']),
    maybeRun('warp-cli', ['--accept-tos', 'settings']),
    maybeRun('warp-cli', ['--accept-tos', 'account']),
    getServiceState(WARP_SERVICE),
    getServiceState(PUBLIC_FORWARD_SERVICE),
    maybeRun('ss', ['-lntp']),
    getPublicForwardConfig(),
  ])

  const parsedSettings = parseWarpSettings(warpSettings.stdout || warpSettings.stderr || '')
  const proxyPort = parsedSettings.proxyPort || publicForwardConfig?.targetPort || null
  const [directIp, proxyIp, directTrace, proxyTrace, hostInfo] = await Promise.all([
    getIpViaCurl(null),
    proxyPort ? getIpViaCurl(proxyPort) : '',
    getTrace(null),
    proxyPort ? getTrace(proxyPort) : '',
    Promise.resolve({ hostname: os.hostname(), platform: `${os.type()} ${os.release()}` }),
  ])

  return {
    generatedAt: new Date().toISOString(),
    authRequired: Boolean(PANEL_PASSWORD),
    hostInfo,
    warp: {
      status: warpStatus.stdout || warpStatus.stderr || '',
      settings: parsedSettings,
      settingsRaw: warpSettings.stdout || warpSettings.stderr || '',
      account: warpAccount.stdout || warpAccount.stderr || '',
      service: warpService,
      directIp,
      proxyIp,
      directTrace,
      proxyTrace,
    },
    publicForward: {
      service: publicForwardService,
      config: publicForwardConfig,
    },
    listeners: listeners.stdout || listeners.stderr || '',
  }
}

app.get('/api/meta', (_req, res) => {
  ok(res, {
    authRequired: Boolean(PANEL_PASSWORD),
    defaultPanelPort: PORT,
    publicForwardService: PUBLIC_FORWARD_SERVICE,
  })
})

app.post('/api/login', (req, res) => {
  if (!PANEL_PASSWORD) {
    return ok(res, { token: null, authRequired: false })
  }
  const password = String(req.body?.password || '')
  if (password !== PANEL_PASSWORD) {
    return fail(res, '密码不正确', 401)
  }
  const token = crypto.randomUUID()
  sessionTokens.set(token, Date.now())
  ok(res, { token, authRequired: true })
})

app.use('/api', requireAuth)

app.get('/api/overview', async (_req, res) => {
  try {
    ok(res, { data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/warp/connect', async (_req, res) => {
  try {
    const result = await run('warp-cli', ['--accept-tos', 'connect'])
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/warp/disconnect', async (_req, res) => {
  try {
    const result = await run('warp-cli', ['--accept-tos', 'disconnect'])
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/warp/mode', async (req, res) => {
  const mode = String(req.body?.mode || '').trim()
  const allow = ['warp', 'doh', 'warp+doh', 'dot', 'warp+dot', 'proxy', 'tunnel_only']
  if (!allow.includes(mode)) {
    return fail(res, '不支持的模式', 400)
  }
  try {
    const result = await run('warp-cli', ['--accept-tos', 'mode', mode])
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/warp/proxy-port', async (req, res) => {
  const port = Number(req.body?.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return fail(res, '代理端口必须是 1024-65535 之间的整数', 400)
  }
  try {
    const result = await run('warp-cli', ['--accept-tos', 'proxy', 'port', String(port)])
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/warp/license', async (req, res) => {
  const license = String(req.body?.license || '').trim()
  if (!license) {
    return fail(res, 'license 不能为空', 400)
  }
  try {
    const result = await run('warp-cli', ['--accept-tos', 'registration', 'license', license])
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/warp/register-new', async (_req, res) => {
  try {
    const result = await run('warp-cli', ['--accept-tos', 'registration', 'new'], { timeout: 60000 })
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

async function writePublicForwardService(publicPort, targetPort, bindHost = '0.0.0.0', targetHost = '127.0.0.1') {
  const content = `[Unit]\nDescription=Public TCP forward for WARP local SOCKS5 proxy\nAfter=network-online.target ${WARP_SERVICE}.service\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/socat TCP-LISTEN:${publicPort},bind=${bindHost},reuseaddr,fork TCP:${targetHost}:${targetPort}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n`
  await fs.writeFile(PUBLIC_FORWARD_SERVICE_PATH, content, 'utf8')
  await run('systemctl', ['daemon-reload'])
}

app.post('/api/public-forward/enable', async (req, res) => {
  const publicPort = Number(req.body?.publicPort)
  const targetPort = Number(req.body?.targetPort)
  if (!Number.isInteger(publicPort) || publicPort < 1024 || publicPort > 65535) {
    return fail(res, '公网端口必须是 1024-65535 之间的整数', 400)
  }
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) {
    return fail(res, '目标端口必须是 1024-65535 之间的整数', 400)
  }
  try {
    await writePublicForwardService(publicPort, targetPort)
    await run('systemctl', ['enable', '--now', PUBLIC_FORWARD_SERVICE])
    ok(res, { output: `${PUBLIC_FORWARD_SERVICE} enabled on ${publicPort} -> ${targetPort}`, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/public-forward/disable', async (_req, res) => {
  try {
    const stop = await maybeRun('systemctl', ['disable', '--now', PUBLIC_FORWARD_SERVICE])
    ok(res, { output: stop.stdout || stop.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/public-forward/restart', async (_req, res) => {
  try {
    const result = await run('systemctl', ['restart', PUBLIC_FORWARD_SERVICE])
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.get('/api/logs/:service', async (req, res) => {
  const service = String(req.params.service || '').trim()
  const allow = [WARP_SERVICE, PUBLIC_FORWARD_SERVICE]
  if (!allow.includes(service)) {
    return fail(res, '不支持的服务名', 400)
  }
  const lines = Math.min(Math.max(Number(req.query.lines || 150), 20), 500)
  try {
    const result = await maybeRun('journalctl', ['-u', service, '-n', String(lines), '--no-pager'])
    ok(res, { service, lines, text: result.stdout || result.stderr || '' })
  } catch (error) {
    fail(res, error.message)
  }
})

app.get('*', (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'))
})

app.listen(PORT, HOST, () => {
  console.log(`WARP panel listening on http://${HOST}:${PORT}`)
})
