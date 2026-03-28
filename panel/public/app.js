const state = {
  overview: null,
  authRequired: false,
  toastTimer: null,
}

const $ = (id) => document.getElementById(id)
const outputBox = $('outputBox')
const toastBox = $('toastBox')

function setOutput(text) {
  if (outputBox) outputBox.textContent = text || ''
}

function showToast(text, type = 'info') {
  if (!toastBox) return
  toastBox.textContent = text || ''
  toastBox.className = `toast-box toast-${type}`
  clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => {
    toastBox.className = 'toast-box hidden'
    toastBox.textContent = ''
  }, 2400)
}

function setButtonBusy(btn, busy, busyText = '处理中...') {
  if (!btn) return
  if (busy) {
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent
    btn.disabled = true
    btn.classList.add('is-busy')
    btn.textContent = busyText
    return
  }
  btn.disabled = false
  btn.classList.remove('is-busy')
  if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText
}

async function withBusy(btn, task, busyText) {
  setButtonBusy(btn, true, busyText)
  try {
    return await task()
  } finally {
    setButtonBusy(btn, false)
  }
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
  const modeText = formatWarpMode(data.warp.settings.mode)
  const proxyPort = data.warp.settings.proxyPort || '-'
  const publicPort = data.publicForward.config?.publicPort || '-'
  const proxyIp = data.warp.proxyIp || '-'
  const directIp = data.warp.directIp || '-'
  const forwardState = `${data.publicForward.service.active} / ${data.publicForward.service.enabled}`

  $('warpState').textContent = stateView.title
  $('warpMode').textContent = `${modeText} · ${stateView.sub}`
  $('proxyPort').textContent = proxyPort
  $('publicPort').textContent = publicPort
  $('publicForwardState').textContent = forwardState
  $('proxyIp').textContent = proxyIp
  $('directIp').textContent = `直连: ${directIp}`
  $('warpSvcState').textContent = `${data.warp.service.active} / ${data.warp.service.enabled}`
  $('forwardSvcState').textContent = forwardState

  $('summaryHeadline').textContent = `${stateView.title} · ${modeText}`
  $('summarySubline').textContent = `本机 ${proxyPort} · 公网 ${publicPort} · 代理出口 ${proxyIp}`
  $('summaryModePill').textContent = `模式 ${modeText}`
  $('summaryProxyPill').textContent = `本机 ${proxyPort}`
  $('summaryForwardPill').textContent = `公网 ${publicPort} · ${data.publicForward.service.active}`
  $('summaryExitPill').textContent = `出口 ${proxyIp}`

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
  showToast('登录成功', 'success')
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: '{}' })
  showAuthScreen(true)
  setOutput('已退出登录')
  showToast('已退出登录', 'info')
}

async function act(path, body = null, successText = '操作成功') {
  const json = await api(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : '{}',
  })
  if (json.data) renderOverview(json.data)
  const message = json.output || successText
  setOutput(message)
  showToast(message, 'success')
  return json
}

async function loadLogs() {
  const service = $('logServiceSelect').value
  const lines = $('logLinesInput').value || '120'
  const json = await api(`/api/logs/${encodeURIComponent(service)}?lines=${encodeURIComponent(lines)}`)
  $('logsBox').textContent = json.text || '当前没有拿到日志输出。'
  $('logsBox').dataset.service = service
}

function flashLogs() {
  const box = $('logsBox')
  if (!box) return
  box.classList.remove('flash-log')
  void box.offsetWidth
  box.classList.add('flash-log')
}

async function refreshWithLogs() {
  await refreshOverview()
  await loadLogs().catch(() => {})
  flashLogs()
}

function wireActions() {
  $('refreshBtn').addEventListener('click', () => withBusy($('refreshBtn'), async () => {
    await refreshWithLogs()
    showToast('状态已刷新', 'info')
  }, '刷新中...').catch(showError))

  $('connectBtn').addEventListener('click', () => withBusy($('connectBtn'), async () => {
    await act('/api/warp/connect', {}, '代理已打开')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await refreshWithLogs()
  }, '正在打开...').catch(showError))

  $('disconnectBtn').addEventListener('click', () => withBusy($('disconnectBtn'), async () => {
    await act('/api/warp/disconnect', {}, '代理已关闭')
    await refreshWithLogs()
  }, '正在关闭...').catch(showError))

  $('logoutBtn').addEventListener('click', () => withBusy($('logoutBtn'), () => logout(), '退出中...').catch(showError))

  $('saveModeBtn').addEventListener('click', () => withBusy($('saveModeBtn'), async () => {
    await act('/api/warp/mode', { mode: $('modeSelect').value }, '工作方式已保存')
    await refreshWithLogs()
  }, '保存中...').catch(showError))

  $('saveProxyPortBtn').addEventListener('click', () => withBusy($('saveProxyPortBtn'), async () => {
    await act('/api/warp/proxy-port', { port: Number($('installProxyPortInput').value) }, '本机端口已保存')
    await refreshWithLogs()
  }, '保存中...').catch(showError))

  $('enableForwardBtn').addEventListener('click', () => withBusy($('enableForwardBtn'), async () => {
    await act('/api/public-forward/enable', {
      publicPort: Number($('installPublicPortInput').value),
      targetPort: Number($('installProxyPortInput').value || state.overview?.warp?.settings?.proxyPort),
    }, '对外代理已启用/更新')
    await refreshWithLogs()
  }, '更新中...').catch(showError))

  $('restartForwardBtn').addEventListener('click', () => withBusy($('restartForwardBtn'), async () => {
    await act('/api/public-forward/restart', {}, '对外代理已重启')
    await refreshWithLogs()
  }, '重启中...').catch(showError))

  $('disableForwardBtn').addEventListener('click', () => withBusy($('disableForwardBtn'), async () => {
    await act('/api/public-forward/disable', {}, '对外代理已停用')
    await refreshWithLogs()
  }, '停用中...').catch(showError))

  $('saveLicenseBtn').addEventListener('click', () => withBusy($('saveLicenseBtn'), async () => {
    await act('/api/warp/license', { license: $('licenseInput').value.trim() }, 'License 已写入')
    await refreshWithLogs()
  }, '写入中...').catch(showError))

  $('registerNewBtn').addEventListener('click', () => withBusy($('registerNewBtn'), async () => {
    await act('/api/warp/register-new', {}, '已重新注册账户')
    await refreshWithLogs()
  }, '注册中...').catch(showError))

  $('loadLogsBtn').addEventListener('click', () => withBusy($('loadLogsBtn'), async () => {
    await loadLogs()
    flashLogs()
    showToast('日志已更新', 'info')
  }, '读取中...').catch(showError))

  $('installBtn').addEventListener('click', () => withBusy($('installBtn'), async () => {
    await act('/api/install/socks5', {
      proxyPort: Number($('installProxyPortInput').value),
      publicPort: Number($('installPublicPortInput').value),
      enablePublicForward: $('installEnableForwardInput').checked,
    }, '代理环境已准备完成')
    await refreshWithLogs()
  }, '准备中...').catch(showError))

  document.querySelectorAll('.service-action').forEach((btn) => {
    btn.addEventListener('click', () => withBusy(btn, async () => {
      await act(`/api/service/${encodeURIComponent(btn.dataset.service)}/${encodeURIComponent(btn.dataset.action)}`, {}, `${btn.dataset.service} ${btn.dataset.action} done`)
      await refreshWithLogs()
    }, `${btn.dataset.action}中...`).catch(showError))
  })

  $('uninstallBtn').addEventListener('click', () => withBusy($('uninstallBtn'), async () => {
    await act('/api/uninstall/socks5', {
      confirm: $('uninstallConfirmInput').value.trim(),
      purge: $('uninstallPurgeInput').checked,
    }, '代理环境已重置 / 清理')
    await refreshWithLogs()
  }, '执行中...').catch(showError))

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault()
    withBusy(e.submitter || $('loginForm').querySelector('button[type="submit"]'), () => login($('passwordInput').value), '登录中...').catch(showError)
  })
}

function showError(err) {
  if (err?.status === 401) {
    showAuthScreen(true)
    setLoginError('密码不正确，或者登录态已失效。')
    showToast('登录态失效，请重新登录', 'error')
    return
  }
  const message = err.message || String(err)
  setOutput(message)
  showToast(message, 'error')
  if ($('loginError') && !$('authScreen').classList.contains('hidden')) {
    setLoginError(message)
  }
  console.error(err)
}

async function bootstrap() {
  bindTabs()
  wireActions()
  await loadMeta().catch(showError)
}

bootstrap()
