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
const SESSION_COOKIE = 'warp_panel_session'
const sessionTokens = new Map()
const PUBLIC_FORWARD_SERVICE = 'warp-socks5-public.service'
const PUBLIC_FORWARD_SERVICE_PATH = '/etc/systemd/system/warp-socks5-public.service'
const WARP_SERVICE = 'warp-svc'
const STATIC_DIR = path.join(process.cwd(), 'public')
const CLOUDFLARE_LIST_KEYRING = '/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg'
const CLOUDFLARE_LIST_FILE = '/etc/apt/sources.list.d/cloudflare-client.list'

app.use(express.json({ limit: '1mb' }))
app.use(express.static(STATIC_DIR))

function ok(res, data = {}) {
  res.json({ ok: true, ...data })
}

function fail(res, error, status = 500, extra = {}) {
  res.status(status).json({ ok: false, error: String(error), ...extra })
}

function parseCookies(req) {
  const raw = req.headers.cookie || ''
  return raw.split(';').map((part) => part.trim()).filter(Boolean).reduce((acc, part) => {
    const i = part.indexOf('=')
    if (i > -1) acc[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1))
    return acc
  }, {})
}

function setSessionCookie(res, token) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ]
  res.setHeader('Set-Cookie', attrs.join('; '))
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
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
  const token = parseCookies(req)[SESSION_COOKIE]
  if (!token || !sessionTokens.has(token)) {
    return fail(res, 'Unauthorized', 401)
  }
  next()
}

function parseWarpSettings(raw) {
  const modeLine = raw.match(/Mode:\s+(.+)/)?.[1]?.trim() || ''
  const proxyPort = Number(raw.match(/WarpProxy on port\s+(\d+)/)?.[1] || 0) || null
  let mode = 'unknown'
  if (/WarpProxy/i.test(modeLine)) mode = 'proxy'
  else if (/warp\+doh/i.test(modeLine)) mode = 'warp+doh'
  else if (/warp\+dot/i.test(modeLine)) mode = 'warp+dot'
  else if (/tunnel_only/i.test(modeLine)) mode = 'tunnel_only'
  else if (/\bwarp\b/i.test(modeLine)) mode = 'warp'
  else if (/\bdoh\b/i.test(modeLine)) mode = 'doh'
  else if (/\bdot\b/i.test(modeLine)) mode = 'dot'
  const protocol = raw.match(/WARP tunnel protocol:\s+(.+)/)?.[1]?.trim() || ''
  return { mode, modeLine, proxyPort, protocol, raw }
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
  if (proxyPort) args.push('-x', `socks5h://127.0.0.1:${proxyPort}`)
  args.push('https://icanhazip.com')
  const result = await maybeRun('curl', args)
  return (result.stdout || '').trim()
}

async function getTrace(proxyPort) {
  const args = ['-sS', '--max-time', '20']
  if (proxyPort) args.push('-x', `socks5h://127.0.0.1:${proxyPort}`)
  args.push('https://www.cloudflare.com/cdn-cgi/trace')
  const result = await maybeRun('curl', args)
  return result.stdout || result.stderr || ''
}

async function isBinaryAvailable(name) {
  const result = await maybeRun('bash', ['-lc', `command -v ${name}`])
  return Boolean((result.stdout || '').trim())
}

async function ensureCloudflareRepo() {
  await run('apt-get', ['update', '-y'], { timeout: 180000 })
  await run('apt-get', ['install', '-y', 'gnupg', 'apt-transport-https', 'ca-certificates', 'net-tools'], { timeout: 180000 })
  const keyCmd = `curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor -o ${CLOUDFLARE_LIST_KEYRING}`
  await run('bash', ['-lc', keyCmd], { timeout: 180000 })
  await fs.writeFile(CLOUDFLARE_LIST_FILE, 'deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main\n', 'utf8')
  await run('apt-get', ['update', '-y'], { timeout: 180000 })
}

async function ensureWarpCliInstalled() {
  if (await isBinaryAvailable('warp-cli')) return 'already-installed'
  await ensureCloudflareRepo()
  await run('apt-get', ['install', '-y', 'cloudflare-warp'], { timeout: 180000 })
  return 'installed'
}

async function ensureWarpRegistration() {
  const account = await maybeRun('warp-cli', ['--accept-tos', 'registration', 'show'])
  if ((account.stdout || '').includes('Account type') || (account.stdout || '').includes('Registered')) {
    return 'already-registered'
  }
  await run('warp-cli', ['--accept-tos', 'registration', 'new'], { timeout: 60000 })
  return 'registered'
}

async function writePublicForwardService(publicPort, targetPort, bindHost = '0.0.0.0', targetHost = '127.0.0.1') {
  const content = `[Unit]\nDescription=Public TCP forward for WARP local SOCKS5 proxy\nAfter=network-online.target ${WARP_SERVICE}.service\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/socat TCP-LISTEN:${publicPort},bind=${bindHost},reuseaddr,fork TCP:${targetHost}:${targetPort}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n`
  await fs.writeFile(PUBLIC_FORWARD_SERVICE_PATH, content, 'utf8')
  await run('systemctl', ['daemon-reload'])
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
  const [directIp, proxyIp, directTrace, proxyTrace, hostInfo, hasWarpCli, hasSocat] = await Promise.all([
    getIpViaCurl(null),
    proxyPort ? getIpViaCurl(proxyPort) : '',
    getTrace(null),
    proxyPort ? getTrace(proxyPort) : '',
    Promise.resolve({ hostname: os.hostname(), platform: `${os.type()} ${os.release()}` }),
    isBinaryAvailable('warp-cli'),
    isBinaryAvailable('socat'),
  ])

  return {
    generatedAt: new Date().toISOString(),
    authRequired: Boolean(PANEL_PASSWORD),
    hostInfo,
    capabilities: {
      socks5Install: true,
      warpCli: hasWarpCli,
      socat: hasSocat,
      supportedModes: ['proxy', 'warp', 'warp+doh', 'warp+dot', 'tunnel_only', 'doh', 'dot'],
      installCores: ['socks5'],
      plannedCores: ['warp-go', 'wgcf'],
    },
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
    authMode: PANEL_PASSWORD ? 'password+httpOnly-cookie' : 'none',
  })
})

app.post('/api/login', (req, res) => {
  if (!PANEL_PASSWORD) return ok(res, { authRequired: false })
  const password = String(req.body?.password || '')
  if (password !== PANEL_PASSWORD) return fail(res, '密码不正确', 401)
  const token = crypto.randomUUID()
  sessionTokens.set(token, Date.now())
  setSessionCookie(res, token)
  ok(res, { authRequired: true })
})

app.post('/api/logout', (_req, res) => {
  const token = parseCookies(_req)[SESSION_COOKIE]
  if (token) sessionTokens.delete(token)
  clearSessionCookie(res)
  ok(res, {})
})

app.use('/api', requireAuth)

app.get('/api/overview', async (_req, res) => {
  try {
    ok(res, { data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.get('/api/install/options', async (_req, res) => {
  try {
    ok(res, {
      data: {
        cores: [
          { key: 'socks5', label: 'Socks5-WARP（当前已支持）', supported: true },
          { key: 'warp-go', label: 'warp-go（计划支持）', supported: false },
          { key: 'wgcf', label: 'wgcf（计划支持）', supported: false },
        ],
        stacks: ['ipv4', 'ipv6', 'dual'],
      },
    })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/install/socks5', async (req, res) => {
  const proxyPort = Number(req.body?.proxyPort)
  const publicPort = Number(req.body?.publicPort)
  const enablePublicForward = Boolean(req.body?.enablePublicForward)
  if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) {
    return fail(res, '内部代理端口必须是 1024-65535 之间的整数', 400)
  }
  if (enablePublicForward && (!Number.isInteger(publicPort) || publicPort < 1024 || publicPort > 65535)) {
    return fail(res, '公网端口必须是 1024-65535 之间的整数', 400)
  }
  try {
    const steps = []
    steps.push(`cloudflare-warp: ${await ensureWarpCliInstalled()}`)
    steps.push(`registration: ${await ensureWarpRegistration()}`)
    await run('warp-cli', ['--accept-tos', 'mode', 'proxy'])
    steps.push('mode=proxy')
    await run('warp-cli', ['--accept-tos', 'proxy', 'port', String(proxyPort)])
    steps.push(`proxy-port=${proxyPort}`)
    await run('warp-cli', ['--accept-tos', 'connect'])
    steps.push('warp connected')
    if (enablePublicForward) {
      await writePublicForwardService(publicPort, proxyPort)
      await run('systemctl', ['enable', '--now', PUBLIC_FORWARD_SERVICE])
      steps.push(`public-forward ${publicPort} -> ${proxyPort}`)
    }
    ok(res, { output: steps.join('\n'), data: await getOverview() })
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
  if (!allow.includes(mode)) return fail(res, '不支持的模式', 400)
  try {
    const result = await run('warp-cli', ['--accept-tos', 'mode', mode])
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/warp/proxy-port', async (req, res) => {
  const port = Number(req.body?.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return fail(res, '代理端口必须是 1024-65535 之间的整数', 400)
  try {
    const result = await run('warp-cli', ['--accept-tos', 'proxy', 'port', String(port)])
    ok(res, { output: result.stdout || result.stderr, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/warp/license', async (req, res) => {
  const license = String(req.body?.license || '').trim()
  if (!license) return fail(res, 'license 不能为空', 400)
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

app.post('/api/public-forward/enable', async (req, res) => {
  const publicPort = Number(req.body?.publicPort)
  const targetPort = Number(req.body?.targetPort)
  if (!Number.isInteger(publicPort) || publicPort < 1024 || publicPort > 65535) return fail(res, '公网端口必须是 1024-65535 之间的整数', 400)
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) return fail(res, '目标端口必须是 1024-65535 之间的整数', 400)
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

app.post('/api/service/:service/:action', async (req, res) => {
  const service = String(req.params.service || '').trim()
  const action = String(req.params.action || '').trim()
  const allowServices = [WARP_SERVICE, PUBLIC_FORWARD_SERVICE]
  const allowActions = ['start', 'stop', 'restart']
  if (!allowServices.includes(service)) return fail(res, '不支持的服务名', 400)
  if (!allowActions.includes(action)) return fail(res, '不支持的服务操作', 400)
  try {
    const result = await run('systemctl', [action, service])
    ok(res, { output: result.stdout || result.stderr || `${service} ${action} done`, data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.post('/api/uninstall/socks5', async (req, res) => {
  const confirm = String(req.body?.confirm || '').trim()
  const purge = Boolean(req.body?.purge)
  if (confirm !== 'DELETE SOCKS5 WARP') {
    return fail(res, '请先输入确认短语：DELETE SOCKS5 WARP', 400)
  }
  try {
    const steps = []
    await maybeRun('systemctl', ['disable', '--now', PUBLIC_FORWARD_SERVICE])
    steps.push('disabled public forward service')
    await maybeRun('warp-cli', ['--accept-tos', 'disconnect'])
    steps.push('warp disconnected')
    if (purge) {
      await maybeRun('apt-get', ['remove', '-y', 'cloudflare-warp'], { timeout: 180000 })
      steps.push('cloudflare-warp removed')
    }
    ok(res, { output: steps.join('\n'), data: await getOverview() })
  } catch (error) {
    fail(res, error.message)
  }
})

app.get('/api/logs/:service', async (req, res) => {
  const service = String(req.params.service || '').trim()
  const allow = [WARP_SERVICE, PUBLIC_FORWARD_SERVICE]
  if (!allow.includes(service)) return fail(res, '不支持的服务名', 400)
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
