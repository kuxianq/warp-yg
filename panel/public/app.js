const state = {
  overview: null,
  authRequired: false,
}

const $ = (id) => document.getElementById(id)
const outputBox = $('outputBox')

function setOutput(text) {
  if (outputBox) outputBox.textContent = text || ''
}

function showAuthScreen(show) {
  $('authScreen').classList.toggle('hidden', !show)
  $('appShell').classList.toggle('hidden', show)
}

function setLoginError(text) {
  $('loginError').textContent = text || ''
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  }
  const res = await fetch(path, { ...options, headers, credentials: 'include' })
  const json = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }))
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `请求失败：${res.status}`)
    err.status = res.status
    throw err
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

function formatWarpMode(mode) {
  switch (mode) {
    case 'proxy': return '代理模式（SOCKS5）'
    case 'warp': return '普通 WARP'
    case 'warp+doh': return 'WARP + DoH'
    case 'warp+dot': return 'WARP + DoT'
    case 'tunnel_only': return '仅隧道'
    case 'doh': return '仅 DoH'
    case 'dot': return '仅 DoT'
    default: return '未识别模式'
  }
}

function formatWarpState(statusRaw) {
  if (/Connected/i.test(statusRaw)) return { title: '已开启', sub: '代理已连接，当前可用' }
  if (/Disconnected/i.test(statusRaw)) return { title: '已关闭', sub: '代理当前未连接' }
  if (/Connecting/i.test(statusRaw)) return { title: '连接中', sub: '正在尝试建立连接' }
  return { title: '未知状态', sub: '请点击刷新状态查看' }
}

function renderOverview(data) {
  state.overview = data
  const stateView = formatWarpState(data.warp.status || '')
  $('warpState').textContent = stateView.title
  $('warpMode').textContent = `${formatWarpMode(data.warp.settings.mode)} · ${stateView.sub}`
  $('proxyPort').textContent = data.warp.settings.proxyPort || '-'
  $('publicPort').textContent = data.publicForward.config?.publicPort || '-'
  $('publicForwardState').textContent = `${data.publicForward.service.active} / ${data.publicForward.service.enabled}`
  $('proxyIp').textContent = data.warp.proxyIp || '-'
  $('directIp').textContent = `直连: ${data.warp.directIp || '-'}`
  $('warpSvcState').textContent = `${data.warp.service.active} / ${data.warp.service.enabled}`
  $('forwardSvcState').textContent = `${data.publicForward.service.active} / ${data.publicForward.service.enabled}`

  $('modeSelect').value = data.warp.settings.mode || 'proxy'
  $('proxyPortInput').value = data.warp.settings.proxyPort || ''
  $('installProxyPortInput').value = data.warp.settings.proxyPort || 40123
  $('installPublicPortInput').value = data.publicForward.config?.publicPort || 40124
  $('publicPortInput').value = data.publicForward.config?.publicPort || $('installPublicPortInput').value

  $('statusRaw').textContent = data.warp.status
  $('settingsRaw').textContent = data.warp.settingsRaw
  $('traceRaw').textContent = data.warp.proxyTrace || data.warp.directTrace || ''
  $('listenersRaw').textContent = data.listeners
  $('accountRaw').textContent = data.warp.account || ''
}

async function refreshOverview() {
  const json = await api('/api/overview')
  renderOverview(json.data)
  return json.data
}

async function loadMeta() {
  const metaRes = await fetch('/api/meta', { credentials: 'include' })
  const meta = await metaRes.json()
  state.authRequired = Boolean(meta.authRequired)

  if (!meta.authRequired) {
    showAuthScreen(false)
    await refreshOverview()
    return
  }

  try {
    await refreshOverview()
    showAuthScreen(false)
    loadLogs().catch(() => {})
  } catch (error) {
    if (error.status === 401) {
      showAuthScreen(true)
      return
    }
    throw error
  }
}

async function login(password) {
  await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
  setLoginError('')
  showAuthScreen(false)
  await refreshOverview()
  await loadLogs().catch(() => {})
  setOutput('登录成功')
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: '{}' })
  showAuthScreen(true)
  setOutput('已退出登录')
}

async function act(path, body = null, successText = '操作成功') {
  const json = await api(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : '{}',
  })
  if (json.data) renderOverview(json.data)
  setOutput(json.output || successText)
  return json
}

async function loadLogs() {
  const service = $('logServiceSelect').value
  const lines = $('logLinesInput').value || '120'
  const json = await api(`/api/logs/${encodeURIComponent(service)}?lines=${encodeURIComponent(lines)}`)
  $('logsBox').textContent = json.text || '当前没有拿到日志输出。'
}

function wireActions() {
  $('refreshBtn').addEventListener('click', async () => {
    await refreshOverview().catch(showError)
    await loadLogs().catch(() => {})
  })
  $('connectBtn').addEventListener('click', async () => {
    await act('/api/warp/connect', {}, '代理已打开').catch(showError)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await refreshOverview().catch(showError)
    await loadLogs().catch(() => {})
  })
  $('disconnectBtn').addEventListener('click', () => act('/api/warp/disconnect', {}, '代理已关闭').then(() => loadLogs().catch(() => {})).catch(showError))
  $('logoutBtn').addEventListener('click', () => logout().catch(showError))
  $('saveModeBtn').addEventListener('click', () => act('/api/warp/mode', { mode: $('modeSelect').value }, '工作方式已保存').then(() => loadLogs().catch(() => {})).catch(showError))
  $('saveProxyPortBtn').addEventListener('click', () => act('/api/warp/proxy-port', { port: Number($('installProxyPortInput').value) }, '本机端口已保存').then(() => {
    $('proxyPortInput').value = $('installProxyPortInput').value
    return loadLogs().catch(() => {})
  }).catch(showError))
  $('enableForwardBtn').addEventListener('click', () => act('/api/public-forward/enable', {
    publicPort: Number($('installPublicPortInput').value),
    targetPort: Number($('installProxyPortInput').value || state.overview?.warp?.settings?.proxyPort),
  }, '对外代理已启用/更新').then(() => {
    $('publicPortInput').value = $('installPublicPortInput').value
    return loadLogs().catch(() => {})
  }).catch(showError))
  $('restartForwardBtn').addEventListener('click', () => act('/api/public-forward/restart', {}, '对外代理已重启').then(() => loadLogs().catch(() => {})).catch(showError))
  $('disableForwardBtn').addEventListener('click', () => act('/api/public-forward/disable', {}, '对外代理已停用').then(() => loadLogs().catch(() => {})).catch(showError))
  $('saveLicenseBtn').addEventListener('click', () => act('/api/warp/license', { license: $('licenseInput').value.trim() }, 'License 已写入').then(() => loadLogs().catch(() => {})).catch(showError))
  $('registerNewBtn').addEventListener('click', () => act('/api/warp/register-new', {}, '已重新注册账户').then(() => loadLogs().catch(() => {})).catch(showError))
  $('loadLogsBtn').addEventListener('click', () => loadLogs().catch(showError))
  $('installBtn').addEventListener('click', () => act('/api/install/socks5', {
    proxyPort: Number($('installProxyPortInput').value),
    publicPort: Number($('installPublicPortInput').value),
    enablePublicForward: $('installEnableForwardInput').checked,
  }, '代理环境已准备完成').then(() => {
    $('proxyPortInput').value = $('installProxyPortInput').value
    $('publicPortInput').value = $('installPublicPortInput').value
    return loadLogs().catch(() => {})
  }).catch(showError))
  document.querySelectorAll('.service-action').forEach((btn) => {
    btn.addEventListener('click', () => act(`/api/service/${encodeURIComponent(btn.dataset.service)}/${encodeURIComponent(btn.dataset.action)}`, {}, `${btn.dataset.service} ${btn.dataset.action} done`).then(() => loadLogs().catch(() => {})).catch(showError))
  })
  $('uninstallBtn').addEventListener('click', () => act('/api/uninstall/socks5', {
    confirm: $('uninstallConfirmInput').value.trim(),
    purge: $('uninstallPurgeInput').checked,
  }, '代理环境已重置 / 清理').then(() => loadLogs().catch(() => {})).catch(showError))
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault()
    login($('passwordInput').value).catch(showError)
  })
}

function showError(err) {
  if (err?.status === 401) {
    showAuthScreen(true)
    setLoginError('密码不正确，或者登录态已失效。')
    return
  }
  setOutput(err.message || String(err))
  if ($('loginError') && !$('authScreen').classList.contains('hidden')) {
    setLoginError(err.message || String(err))
  }
  console.error(err)
}

async function bootstrap() {
  bindTabs()
  wireActions()
  await loadMeta().catch(showError)
}

bootstrap()
