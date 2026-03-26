const state = {
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
  const res = await fetch(path, { ...options, headers, credentials: 'include' })
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
  const connected = data.warp.status.includes('Connected')
  $('warpState').textContent = connected ? '已连接' : (data.warp.status || '未知')
  $('warpMode').textContent = data.warp.settings.modeLine || '未识别模式'
  $('proxyPort').textContent = data.warp.settings.proxyPort || '-'
  $('publicPort').textContent = data.publicForward.config?.publicPort || '-'
  $('publicForwardState').textContent = `${data.publicForward.service.active} / ${data.publicForward.service.enabled}`
  $('proxyIp').textContent = data.warp.proxyIp || '-'
  $('directIp').textContent = `直连: ${data.warp.directIp || '-'}`
  $('warpSvcState').textContent = `${data.warp.service.active} / ${data.warp.service.enabled}`
  $('forwardSvcState').textContent = `${data.publicForward.service.active} / ${data.publicForward.service.enabled}`

  $('modeSelect').value = data.warp.settings.mode || 'proxy'
  $('proxyPortInput').value = data.warp.settings.proxyPort || ''
  $('publicPortInput').value = data.publicForward.config?.publicPort || ''
  $('installProxyPortInput').value = data.warp.settings.proxyPort || 40123
  $('installPublicPortInput').value = data.publicForward.config?.publicPort || 40124

  $('statusRaw').textContent = data.warp.status
  $('settingsRaw').textContent = data.warp.settingsRaw
  $('traceRaw').textContent = data.warp.proxyTrace || data.warp.directTrace || ''
  $('listenersRaw').textContent = data.listeners
  $('accountRaw').textContent = data.warp.account || ''
}

async function refreshOverview() {
  const json = await api('/api/overview')
  $('loginCard').classList.add('hidden')
  $('logoutBtn').style.display = 'inline-flex'
  renderOverview(json.data)
}

async function loadMeta() {
  const metaRes = await fetch('/api/meta', { credentials: 'include' })
  const meta = await metaRes.json()
  if (meta.authRequired) {
    try {
      await refreshOverview()
    } catch {
      $('loginCard').classList.remove('hidden')
      $('logoutBtn').style.display = 'none'
    }
  } else {
    await refreshOverview()
  }
}

async function login(password) {
  await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
  await refreshOverview()
  setOutput('登录成功')
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: '{}' })
  $('loginCard').classList.remove('hidden')
  $('logoutBtn').style.display = 'none'
  setOutput('已退出登录')
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
  $('logoutBtn').addEventListener('click', () => logout().catch(showError))
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
  $('installBtn').addEventListener('click', () => act('/api/install/socks5', {
    proxyPort: Number($('installProxyPortInput').value),
    publicPort: Number($('installPublicPortInput').value),
    enablePublicForward: $('installEnableForwardInput').checked,
  }, 'Socks5-WARP 安装/收口完成').catch(showError))
  document.querySelectorAll('.service-action').forEach((btn) => {
    btn.addEventListener('click', () => act(`/api/service/${encodeURIComponent(btn.dataset.service)}/${encodeURIComponent(btn.dataset.action)}`, {}, `${btn.dataset.service} ${btn.dataset.action} done`).catch(showError))
  })
  $('uninstallBtn').addEventListener('click', () => act('/api/uninstall/socks5', {
    confirm: $('uninstallConfirmInput').value.trim(),
    purge: $('uninstallPurgeInput').checked,
  }, 'Socks5-WARP 已清理').catch(showError))
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
}

bootstrap()
