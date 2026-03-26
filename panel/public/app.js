const state = {
  token: localStorage.getItem('warp_panel_token') || '',
  overview: null,
}

const $ = (id) => document.getElementById(id)
const outputBox = $('outputBox')

function setOutput(text) {
  outputBox.textContent = text || ''
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  }
  if (state.token) headers['x-panel-token'] = state.token
  const res = await fetch(path, { ...options, headers })
  const json = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }))
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `请求失败：${res.status}`)
  }
  return json
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach((el) => el.classList.remove('active'))
      btn.classList.add('active')
      $(btn.dataset.target).classList.add('active')
    })
  })
}

function renderOverview(data) {
  state.overview = data
  const warpState = data.warp.status.includes('Connected') ? '已连接' : data.warp.status || '未知'
  $('warpState').textContent = warpState
  $('warpMode').textContent = data.warp.settings.mode || '未识别模式'
  $('proxyPort').textContent = data.warp.settings.proxyPort || '-'
  $('publicPort').textContent = data.publicForward.config?.publicPort || '-'
  $('publicForwardState').textContent = `${data.publicForward.service.active} / ${data.publicForward.service.enabled}`
  $('proxyIp').textContent = data.warp.proxyIp || '-'
  $('directIp').textContent = `直连: ${data.warp.directIp || '-'}`
  $('modeSelect').value = (data.warp.settings.mode || '').startsWith('WarpProxy') ? 'proxy' : (data.warp.settings.mode?.split(' ')[0]?.toLowerCase() || 'proxy')
  $('proxyPortInput').value = data.warp.settings.proxyPort || ''
  $('publicPortInput').value = data.publicForward.config?.publicPort || ''
  $('statusRaw').textContent = data.warp.status
  $('settingsRaw').textContent = data.warp.settingsRaw
  $('traceRaw').textContent = data.warp.proxyTrace || data.warp.directTrace || ''
  $('listenersRaw').textContent = data.listeners
}

async function refreshOverview() {
  const json = await api('/api/overview')
  $('loginCard').classList.add('hidden')
  renderOverview(json.data)
}

async function loadMeta() {
  const meta = await fetch('/api/meta').then((r) => r.json())
  if (meta.authRequired && !state.token) {
    $('loginCard').classList.remove('hidden')
  }
}

async function login(password) {
  const json = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
  if (json.token) {
    state.token = json.token
    localStorage.setItem('warp_panel_token', json.token)
  }
  await refreshOverview()
  setOutput('登录成功')
}

async function act(path, body = null, successText = '操作成功') {
  const json = await api(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : '{}',
  })
  if (json.data) renderOverview(json.data)
  setOutput(json.output || successText)
}

async function loadLogs() {
  const service = $('logServiceSelect').value
  const lines = $('logLinesInput').value || '120'
  const json = await api(`/api/logs/${encodeURIComponent(service)}?lines=${encodeURIComponent(lines)}`)
  $('logsBox').textContent = json.text || ''
}

function wireActions() {
  $('refreshBtn').addEventListener('click', () => refreshOverview().catch(showError))
  $('connectBtn').addEventListener('click', () => act('/api/warp/connect').catch(showError))
  $('disconnectBtn').addEventListener('click', () => act('/api/warp/disconnect').catch(showError))
  $('saveModeBtn').addEventListener('click', () => act('/api/warp/mode', { mode: $('modeSelect').value }, '模式已切换').catch(showError))
  $('saveProxyPortBtn').addEventListener('click', () => act('/api/warp/proxy-port', { port: Number($('proxyPortInput').value) }, '内部代理端口已修改').catch(showError))
  $('enableForwardBtn').addEventListener('click', () => act('/api/public-forward/enable', {
    publicPort: Number($('publicPortInput').value),
    targetPort: Number($('proxyPortInput').value || state.overview?.warp?.settings?.proxyPort),
  }, '公网转发已启用/更新').catch(showError))
  $('restartForwardBtn').addEventListener('click', () => act('/api/public-forward/restart', {}, '公网转发已重启').catch(showError))
  $('disableForwardBtn').addEventListener('click', () => act('/api/public-forward/disable', {}, '公网转发已停用').catch(showError))
  $('saveLicenseBtn').addEventListener('click', () => act('/api/warp/license', { license: $('licenseInput').value.trim() }, 'License 已写入').catch(showError))
  $('registerNewBtn').addEventListener('click', () => act('/api/warp/register-new', {}, '已重新注册账户').catch(showError))
  $('loadLogsBtn').addEventListener('click', () => loadLogs().catch(showError))
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault()
    login($('passwordInput').value).catch(showError)
  })
}

function showError(err) {
  setOutput(err.message || String(err))
  console.error(err)
}

async function bootstrap() {
  bindTabs()
  wireActions()
  await loadMeta().catch(showError)
  if (state.token) {
    await refreshOverview().catch(showError)
  }
}

bootstrap()
