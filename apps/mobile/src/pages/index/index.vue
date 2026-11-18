<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import { HostClient, uniRequest } from '../../lib/host-client.mjs'
import { deviceIdentity } from '../../lib/device-identity.mjs'
import { DurableState, mobileStorage } from '../../lib/durable-state.mjs'
import {
  openRemoteServer,
  connectRemoteHost,
  enqueueRemote,
  openPairingInvitation,
} from '../../lib/remote-link.mjs'
import { parsePairingInvitation } from '@bigdogoffice/remote-core/pairing'
import { scanPairing } from '../../lib/pairing-scan.mjs'
import { recentReceipts, matchesQueuedReceipt } from '../../lib/receipt-scope.mjs'
import AppIcon from '../../components/AppIcon.vue'
import SessionDrawer from '../../components/SessionDrawer.vue'
import AppSheet from '../../components/AppSheet.vue'
import MessageContent from '../../components/MessageContent.vue'
import { noticeForAcceptedTask } from '../../lib/task-notice.mjs'
import { documentFileType, ensureDocumentExtension } from '../../lib/document-file.mjs'
import {
  selectTask,
  taskTitle,
  taskStateLabel,
  taskOutcome,
  pendingPredecessor,
  permissionCopy,
  retryBudgetExhausted,
  taskResultSummaries,
} from '../../lib/task-presentation.mjs'
import { canQueueOffline, blockCommand, deliverCommand } from '../../lib/outbox.mjs'
import {
  DraftLedger,
  newRequestId,
  normalizeHistory,
  taskLabels,
  userError,
} from '../../lib/state.mjs'

const resultLabels = {
  completed: '操作已完成',
  partial: '部分完成',
  failed: '操作未完成',
  cancelled: '操作已取消',
  undone: '操作已撤销',
  'undo-failed': '撤销未完成',
}
const taskReason = (code) =>
  ({
    execution_failed: '执行未完成，可重试继续。',
    device_offline: '等待执行电脑上线。',
    user_paused: '任务已暂停，可继续执行。',
    process_interrupted: '上次执行中断，需要核对状态。',
    approval_expired: '操作确认已过期，这次操作未执行。可重试任务并重新确认。',
    operation_not_completed: '请求中的操作未完成，可核对原因后重试。',
  })[code] || '请核对任务状态后继续。'
const durable = new DurableState(mobileStorage())
const client = new HostClient(uniRequest, deviceIdentity, durable)
const ledger = new DraftLedger(newRequestId, durable)
for (const item of durable.list()) {
  const split = item.key.indexOf('|')
  const catalog = durable.value.catalogs[item.key.slice(0, split)] || []
  if (
    catalog.some((session) => session.id === item.key.slice(split + 1) && session.kind === 'file')
  )
    blockCommand(durable, item, new Error('EDITOR_REQUIRED'))
}
const nativeReader = Boolean(globalThis.BigDogNative?.pdfPage)
const savedConnection = durable.value.connection || {}
const advancedConnection = ref(false),
  invitationText = ref(''),
  scannedInvitation = ref(null),
  pairingProgress = ref('')
async function scanInvitation(mode) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const text = await scanPairing(mode)
    invitationText.value = text
    scannedInvitation.value = parsePairingInvitation(text)
  } catch (reason) {
    if (reason?.message !== 'PAIRING_SCAN_CANCELLED') setError(reason)
  } finally {
    busy.value = false
  }
}
async function acceptInvitation() {
  if (busy.value) return
  error.value = ''
  let invite
  try {
    invite = parsePairingInvitation(invitationText.value)
  } catch (reason) {
    setError(reason)
    return
  }
  // Show the destination before redeeming any capability or replacing a saved connection.
  if (!scannedInvitation.value || scannedInvitation.value.ticket !== invite.ticket) {
    scannedInvitation.value = invite
    return
  }
  busy.value = true
  pairingProgress.value = '正在验证电脑邀请…'
  try {
    const server = await openPairingInvitation(invite, deviceName.value, deviceIdentity)
    remoteServer = server
    remoteMode.value = true
    serverAddress.value = invite.server
    chosenRemote.value = invite.host
    remoteDevices.value = server.devices
    pairingCode.value = invite.code
    pairingProgress.value = '正在连接电脑…'
  } catch (reason) {
    setError(reason)
    return
  } finally {
    busy.value = false
  }
  await connect()
  pairingProgress.value = ''
  if (connected.value) {
    invitationText.value = ''
    scannedInvitation.value = null
  }
}
const remoteMode = ref(savedConnection.remoteMode || false),
  serverAddress = ref(savedConnection.serverAddress || ''),
  remoteAccount = ref(savedConnection.remoteAccount || ''),
  remotePassword = ref(''),
  remoteDevices = ref([]),
  chosenRemote = ref(savedConnection.chosenRemote || ''),
  routeLabel = ref('')
let remoteServer, remoteLink
let reconnecting = false,
  reconnectAt = 0
async function reconnectRemote() {
  if (
    transferBusy.value ||
    !remoteMode.value ||
    !connected.value ||
    !remoteServer ||
    reconnecting ||
    Date.now() < reconnectAt ||
    remoteLink?.stats()?.connected
  )
    return
  reconnecting = true
  reconnectAt = Date.now() + 5000
  let link
  try {
    link = await connectRemoteHost(remoteServer, chosenRemote.value)
    selectionEpoch++
    await remoteLink?.close()
    remoteLink = link
    link = undefined
    client.disconnect()
    client.request = remoteLink.request
    await client.resume(remoteLink.base)
    syncError.value = ''
    if (notice.value === '电脑暂时离线，待发请求会加密保存在服务器，电脑上线后处理。')
      notice.value = ''
    await refreshSessions()
    await refreshChat()
    void flushOutbox()
  } catch (reason) {
    if (/AUTH|IDENTITY|KEY|REVOKED|SECURE/.test(reason?.code || reason?.message || ''))
      setError(reason)
  } finally {
    await link?.close()
    reconnecting = false
  }
}
const transferTarget = ref(''),
  transferCode = ref(''),
  transferBusy = ref(false),
  transferProgress = ref(''),
  pushStatus = ref('')
let registeredEndpoint = ''
function openLicenses() {
  if (globalThis.BigDogNative?.showNotices) globalThis.BigDogNative.showNotices()
  else aboutOpen.value = true
}
async function enablePush() {
  if (!globalThis.BigDogNative) {
    pushStatus.value = '请使用 Android 独立应用启用推送。'
    return
  }
  globalThis.BigDogNative.notificationPermission()
  const state = JSON.parse(globalThis.BigDogNative.pushState())
  if (!state.distributors?.length) {
    pushStatus.value = '需要先安装并配置 UnifiedPush 分发器，例如连接自部署服务器的 ntfy。'
    return
  }
  globalThis.BigDogNative.registerPush()
  pushStatus.value = '请完成系统中的推送服务选择。'
}
async function syncPush() {
  if (!remoteServer || !globalThis.BigDogNative?.pushState) return
  try {
    const state = JSON.parse(globalThis.BigDogNative.pushState())
    if (state.endpoint && state.endpoint !== registeredEndpoint) {
      await remoteServer.api.courier('push', { endpoint: state.endpoint })
      registeredEndpoint = state.endpoint
      pushStatus.value = '推送服务已连接。'
    }
  } catch {
    pushStatus.value = '推送地址尚未获服务器允许，请检查自部署推送配置。'
  }
}
async function transferSession() {
  if (!selected.value || !remoteServer || !transferTarget.value || transferBusy.value) return
  const sid = selected.value.id,
    target = transferTarget.value,
    source = chosenRemote.value,
    sourceHost = client.hostId
  const confirmed = await new Promise((resolve) =>
    uni.showModal({
      title: '迁移到另一台电脑',
      content:
        '仅迁移没有未完成任务的会话。对话、记忆和已保存成果将一同复制，原电脑保留归档副本并停止执行。',
      success: (r) => resolve(r.confirm),
      fail: () => resolve(false),
    }),
  )
  if (!confirmed) return
  transferBusy.value = true
  transferProgress.value = '正在确认目标电脑…'
  error.value = ''
  clearInterval(timer)
  selectionEpoch++
  const id = `${sourceHost}|${sid}|${target}`
  durable.value.handoffs ??= {}
  const stage = (durable.value.handoffs[id] ??= { requestId: newRequestId(), target })
  durable.save()
  async function switchHost(hostId, code = '') {
    client.disconnect()
    await remoteLink?.close()
    remoteLink = undefined
    remoteLink = await connectRemoteHost(remoteServer, hostId)
    client.request = remoteLink.request
    if (code.trim()) await client.pair(remoteLink.base, code, deviceName.value)
    else await client.resume(remoteLink.base)
  }
  try {
    // The upstream coordinator permits one active client link. Authenticate the
    // target, collect the bounded source bundle, then reconnect to upload it.
    await switchHost(target, transferCode.value)
    transferCode.value = ''
    if (!stage.uploaded) {
      await switchHost(source)
      const manifest = await client.rpc('handoff.prepare', {
        sessionId: sid,
        target,
        requestId: stage.requestId,
      })
      if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes > 32 * 1024 * 1024)
        throw new Error('HANDOFF_TOO_LARGE')
      stage.manifest = manifest
      durable.save()
      const chunks = []
      let offset = 0
      while (manifest.state !== 'completed' && offset < manifest.bytes) {
        const chunk = await client.rpc('handoff.read', {
          sessionId: sid,
          ticket: manifest.ticket,
          offset,
        })
        if (chunk.nextOffset <= offset || chunk.nextOffset > manifest.bytes)
          throw new Error('HANDOFF_OFFSET')
        chunks.push({ offset, base64: chunk.base64 })
        offset = chunk.nextOffset
        transferProgress.value = `正在读取会话与成果 ${Math.round((100 * offset) / manifest.bytes)}%`
      }
      await switchHost(target)
      for (const chunk of chunks) {
        await client.rpc('handoff.upload', { manifest, ...chunk })
        transferProgress.value = '正在传送会话与成果…'
      }
      stage.uploaded = true
      durable.save()
    }
    const result = await client.rpc('handoff.accept', { manifest: stage.manifest })
    stage.completed = true
    stage.sessionId = result.sessionId
    chosenRemote.value = target
    durable.value.connection.chosenRemote = target
    durable.save()
    await refreshSessions()
    openSession(
      sessions.value.find((item) => item.id === result.sessionId) || {
        id: result.sessionId,
        title: '已迁移对话',
        kind: 'workspace',
      },
    )
    transferProgress.value = '迁移完成，执行主机已切换。'
    transferTarget.value = ''
    notice.value = `已迁移至${hostName.value}，原对话和成果已保留。`
  } catch (reason) {
    setError(reason)
    transferProgress.value = '交接尚未完成，可重试继续；准备完成后原电脑会保持保护状态。'
    await switchHost(source).catch(() => {})
  } finally {
    transferBusy.value = false
    startPolling()
  }
}
async function discoverRemote() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    remoteServer = await openRemoteServer(
      serverAddress.value,
      remoteAccount.value,
      remotePassword.value,
      deviceName.value,
    )
    remotePassword.value = ''
    remoteDevices.value = remoteServer.devices.filter(
      (d) => d.role === 'host' || d.role === undefined,
    )
    if (remoteDevices.value.length === 1) chosenRemote.value = remoteDevices.value[0].deviceId
    return true
  } catch (reason) {
    setError(reason)
    return false
  } finally {
    busy.value = false
  }
}
async function reconnectSaved() {
  if (remoteMode.value && !(await discoverRemote())) return
  await connect()
}
function replaceInvitation() {
  scannedInvitation.value = null
  invitationText.value = ''
  error.value = ''
}
const connected = ref(false),
  screen = ref('connect'),
  busy = ref(false),
  sending = ref(false)
const address = ref(savedConnection.address || 'http://127.0.0.1:48219'),
  pairingCode = ref(''),
  deviceName = ref(savedConnection.deviceName || '大狗手机')
const error = ref(''),
  notice = ref(''),
  sessions = ref([]),
  selected = ref(null)
const messages = ref([]),
  tasks = ref([]),
  artifacts = ref([]),
  records = ref([])
const drawerOpen = ref(false),
  settingsOpen = ref(false),
  showTaskPanel = ref(false),
  aboutOpen = ref(false)
const preferenceStorage = mobileStorage()
let savedPreferences = {}
try {
  savedPreferences = JSON.parse(preferenceStorage.get('bigdog.mobile.appearance.v1') || '{}') || {}
} catch {}
const theme = ref(
  ['system', 'light', 'dark'].includes(savedPreferences.theme) ? savedPreferences.theme : 'system',
)
const largeText = ref(savedPreferences.largeText === true)
const systemTheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
function updateNativeAppearance() {
  globalThis.BigDogNative?.appearance?.(
    theme.value === 'dark' || (theme.value === 'system' && systemTheme?.matches) ? 'dark' : 'light',
  )
}
watch(theme, updateNativeAppearance, { immediate: true })
systemTheme?.addEventListener?.('change', updateNativeAppearance)
watch([theme, largeText], () => {
  try {
    preferenceStorage.set(
      'bigdog.mobile.appearance.v1',
      JSON.stringify({ theme: theme.value, largeText: largeText.value }),
    )
  } catch {
    error.value = '外观已应用，但本机未能保存，下次启动将恢复默认。'
  }
})
function openSettings() {
  drawerOpen.value = false
  settingsOpen.value = true
}
function openDrawer() {
  drawerOpen.value = true
  void refreshSessions()
}
function openTasks() {
  showTaskPanel.value = true
  void refreshChat()
}
function chooseTask(id) {
  selectedTaskId.value = id
  showTaskList.value = false
}
function showTaskResults() {
  showTaskPanel.value = false
  showFiles()
}
const tab = ref('chat'),
  draft = ref(''),
  scrollAnchor = ref(''),
  previewText = ref(''),
  previewName = ref('')
const chatScrollTop = ref(0),
  previewHint = ref(''),
  hasNewMessages = ref(false)
const chatAtBottom = ref(true)
let scrollMeasurement = 0
function onChatScroll(event) {
  chatScrollTop.value = event.detail.scrollTop
  const measure = ++scrollMeasurement,
    epoch = selectionEpoch
  const { scrollTop, scrollHeight } = event.detail
  uni
    .createSelectorQuery()
    .select('.message-scroller')
    .boundingClientRect((box) => {
      if (
        box?.height &&
        measure === scrollMeasurement &&
        epoch === selectionEpoch &&
        tab.value === 'chat'
      )
        chatAtBottom.value = scrollHeight - scrollTop - box.height < 80
    })
    .exec()
}
const previewImage = ref(''),
  pdfContent = ref(''),
  pdfPage = ref(0),
  pdfPages = ref(0)
async function turnPdf(delta) {
  try {
    const page = pdfPage.value + delta
    const result = JSON.parse(globalThis.BigDogNative.pdfPage(pdfContent.value, page, 1000))
    if (result.error) throw new Error(result.error)
    pdfPage.value = page
    pdfPages.value = result.pages
    previewImage.value = result.image
  } catch (reason) {
    setError(reason)
  }
}
const loadingChat = ref(false),
  downloadingId = ref(''),
  acceptedTaskId = ref('')
const historyMore = ref(false)
const syncError = ref(''),
  resultsError = ref(''),
  tasksAvailable = ref(true)
let selectionEpoch = 0,
  catalogEpoch = 0,
  catalogLoading = false,
  pollingKey = '',
  timer,
  pendingCreate
let flushing = false
let syncingReceipts = false
const delivered = ref([])
const decisionBusy = ref(false),
  decisionText = ref('')
const queueItems = ref(durable.list())
const queuedCount = computed(
  () => queueItems.value.filter((item) => item.status !== 'blocked').length,
)
const blockedCount = computed(
  () => queueItems.value.filter((item) => item.status === 'blocked').length,
)
const showOutbox = ref(false),
  showTaskList = ref(false),
  showTransfer = ref(false)
const selectedTaskId = ref(''),
  hostOnline = ref(false)
const hostName = computed(() =>
  remoteMode.value
    ? remoteDevices.value.find((device) => device.deviceId === chosenRemote.value)?.name ||
      '已配对电脑'
    : address.value,
)
const pendingDraft = computed(() => {
  if (!selected.value) return undefined
  return queueItems.value.find(
    (item) =>
      item.key === keyFor(selected.value.id) &&
      item.text === draft.value.trim() &&
      item.envelope &&
      item.status !== 'blocked',
  )
})
const readOnly = computed(
  () => selected.value?.kind === 'file' || selected.value?.canSend === false,
)
const attentionSessions = computed(() => sessions.value.filter((session) => session.attention))
const predecessor = computed(() => pendingPredecessor(activeTask.value, tasks.value))
const taskChoices = computed(() =>
  [activeTask.value, ...tasks.value]
    .filter((task, index, all) => task && all.findIndex((item) => item?.id === task.id) === index)
    .slice(0, 12),
)
const selectedTitle = computed(() => selected.value?.title || '对话')
const activeTask = computed(() => selectTask(tasks.value, selectedTaskId.value))
const taskLabel = computed(() =>
  !tasksAvailable.value ? '任务状态暂不可用' : taskStateLabel(activeTask.value, records.value),
)
const composerNotice = computed(() =>
  pendingDraft.value
    ? pendingDraft.value.status === 'server-queued'
      ? '已保存到服务器，等待电脑接收，无需再次发送。'
      : '已保存在手机，正在核对服务器接收状态，无需重复发送。'
    : !tasksAvailable.value && acceptedTaskId.value
      ? '连接中断，等待同步任务状态。'
      : noticeForAcceptedTask(
          tasksAvailable.value && acceptedTaskId.value
            ? tasks.value.find((task) => task.id === acceptedTaskId.value)
            : undefined,
          notice.value,
        ),
)
const keyFor = (id) => `${client.hostId || client.base}|${id}`
const isCurrent = (id, epoch) =>
  connected.value && selected.value?.id === id && selectionEpoch === epoch

function setError(reason) {
  error.value = userError(reason)
}
function updateOutbox() {
  queueItems.value = durable.list().map((item) => ({ ...item }))
}
function outboxSession(item) {
  const hostId = item.key.slice(0, item.key.indexOf('|'))
  const sid = item.key.slice(item.key.indexOf('|') + 1)
  const session = durable.value.catalogs[hostId]?.find((s) => s.id === sid)
  const savedAddress =
    Object.entries(durable.value.hosts).find(([, identity]) => identity.hostId === hostId)?.[0] ||
    ''
  const remoteId = /^https:\/\/(.+)\.bigdog\.invalid$/.exec(savedAddress)?.[1]
  const name = remoteDevices.value.find((device) => device.deviceId === remoteId)?.name
  return `${session?.title || '原会话'} · ${name || (hostId === client.hostId ? hostName.value : '另一台已配对电脑')}`
}
function returnDraft(item) {
  if (item.status !== 'blocked' || item.envelope) return
  try {
    ledger.returnToDraft(item.key, item.requestId)
    if (selected.value && item.key === keyFor(selected.value.id)) draft.value = ledger.get(item.key)
    updateOutbox()
  } catch (reason) {
    setError(reason)
  }
}
function continueTask() {
  if (!activeTask.value || readOnly.value) return
  if (!draft.value.trim()) {
    draft.value = `继续这项尚未完成的任务：${taskTitle(activeTask.value)}。请先说明剩余事项，涉及写入仍逐次确认。`
    ledger.set(keyFor(selected.value.id), draft.value)
  }
  tab.value = 'chat'
  showTaskPanel.value = false
  void bottom()
}
async function bottom() {
  hasNewMessages.value = false
  chatAtBottom.value = true
  scrollAnchor.value = ''
  await nextTick()
  scrollAnchor.value = 'message-bottom'
}
function saveDraft(event) {
  draft.value = event.detail.value
  if (selected.value) ledger.set(keyFor(selected.value.id), draft.value)
}
async function connect() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    let target = address.value
    if (remoteMode.value) {
      if (!remoteServer || !chosenRemote.value) throw new Error('REMOTE_HOST_REQUIRED')
      await remoteLink?.close()
      target = `https://${chosenRemote.value}.bigdog.invalid`
      try {
        remoteLink = await connectRemoteHost(remoteServer, chosenRemote.value)
        client.request = remoteLink.request
        routeLabel.value = remoteLink.stats()?.mode || '加密连接'
      } catch (reason) {
        const remembered = durable.host(target)
        if (!remembered || reason?.message === 'HOST_IDENTITY_CHANGED') throw reason
        client.disconnect()
        client.base = target
        client.hostId = remembered.hostId
        client.deviceId = remembered.deviceId
        client.request = async () => {
          throw new Error('HOST_OFFLINE')
        }
        connected.value = true
        screen.value = 'sessions'
        sessions.value = durable.value.catalogs[client.hostId] || []
        notice.value = '电脑暂时离线，待发请求会加密保存在服务器，电脑上线后处理。'
        return
      }
    } else client.request = uniRequest
    if (pairingCode.value.trim()) {
      try {
        await client.pair(target, pairingCode.value, deviceName.value)
      } catch (reason) {
        if (reason?.code !== 'PAIRING_USED') throw reason
        // A lost pairing response must be recovered with the same persistent device key.
        await client.resume(target)
      }
    } else await client.resume(target)
    connected.value = true
    delivered.value = remoteServer
      ? recentReceipts(durable.value.receipts, remoteServer.api.baseUrl, chosenRemote.value)
      : []
    durable.value.connection = {
      remoteMode: remoteMode.value,
      serverAddress: serverAddress.value,
      remoteAccount: remoteAccount.value,
      chosenRemote: chosenRemote.value,
      address: address.value,
      deviceName: deviceName.value,
    }
    durable.save()
    pairingCode.value = ''
    screen.value = 'sessions'
    pendingCreate = undefined
    await refreshSessions()
    void flushOutbox()
  } catch (reason) {
    setError(reason)
  } finally {
    busy.value = false
  }
}
function disconnect() {
  settingsOpen.value = false
  drawerOpen.value = false
  showTaskPanel.value = false
  showOutbox.value = false
  if (selected.value) ledger.set(keyFor(selected.value.id), draft.value)
  client.disconnect()
  void remoteLink?.close()
  remoteLink = undefined
  syncError.value = ''
  resultsError.value = ''
  connected.value = false
  delivered.value = []
  hostOnline.value = false
  selectionEpoch++
  catalogEpoch++
  catalogLoading = false
  selected.value = null
  sessions.value = []
  messages.value = []
  tasks.value = []
  artifacts.value = []
  records.value = []
  screen.value = 'connect'
  error.value = ''
  notice.value = ''
  acceptedTaskId.value = ''
  previewText.value = ''
  pendingCreate = undefined
}
async function refreshSessions() {
  if (catalogLoading || !connected.value) return
  catalogLoading = true
  const epoch = ++catalogEpoch
  try {
    const result = await client.rpc('sessions.list', { state: 'active', limit: 100 })
    if (!connected.value || epoch !== catalogEpoch) return
    sessions.value = Array.isArray(result?.sessions) ? result.sessions : []
    if (selected.value)
      selected.value =
        sessions.value.find((item) => item.id === selected.value.id) || selected.value
    durable.value.catalogs[client.hostId] = sessions.value
    durable.save()
    syncError.value = ''
    hostOnline.value = true
  } catch (reason) {
    if (canQueueOffline(reason)) hostOnline.value = false
    if (connected.value && epoch === catalogEpoch && screen.value === 'sessions')
      syncError.value = userError(reason)
  } finally {
    if (epoch === catalogEpoch) catalogLoading = false
  }
}
async function createSession() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  pendingCreate ??= {
    kind: 'create',
    requestId: newRequestId(),
    title: '新对话',
    projectId: 'default',
  }
  try {
    const result = await client.rpc('sessions.command', pendingCreate)
    if (!connected.value || transferBusy.value) return
    void reconnectRemote()
    void flushOutbox()
    routeLabel.value = remoteLink?.stats()?.mode || ''
    pendingCreate = undefined
    await refreshSessions()
    openSession(
      sessions.value.find((s) => s.id === result.sessionId) || {
        id: result.sessionId,
        title: '新对话',
        kind: 'workspace',
      },
    )
  } catch (reason) {
    setError(reason)
  } finally {
    busy.value = false
  }
}
function openSession(session) {
  drawerOpen.value = false
  settingsOpen.value = false
  showTaskPanel.value = false
  if (selected.value) ledger.set(keyFor(selected.value.id), draft.value)
  selectionEpoch++
  selected.value = session
  selectedTaskId.value = ''
  showTaskList.value = false
  showTransfer.value = false
  screen.value = 'conversation'
  tab.value = 'chat'
  draft.value = ledger.get(keyFor(session.id))
  chatScrollTop.value = 0
  chatAtBottom.value = true
  scrollAnchor.value = ''
  messages.value = durable.value.history[keyFor(session.id)] || []
  hasNewMessages.value = false
  tasks.value = []
  artifacts.value = []
  records.value = []
  error.value = ''
  notice.value = ''
  acceptedTaskId.value = ''
  loadingChat.value = true
  historyMore.value = false
  syncError.value = ''
  resultsError.value = ''
  tasksAvailable.value = true
  void refreshChat(true)
}
function openAttentionSession(session) {
  openSession(session)
  showTaskPanel.value = true
}
function back() {
  if (aboutOpen.value) {
    aboutOpen.value = false
    return
  }
  if (showTaskPanel.value) {
    showTaskPanel.value = false
    return
  }
  if (showOutbox.value) {
    showOutbox.value = false
    return
  }
  if (drawerOpen.value) {
    drawerOpen.value = false
    return
  }
  if (settingsOpen.value) {
    settingsOpen.value = false
    return
  }
  if (screen.value === 'preview') {
    screen.value = 'conversation'
    return
  }
  if (selected.value) ledger.set(keyFor(selected.value.id), draft.value)
  selectionEpoch++
  screen.value = 'sessions'
  selected.value = null
  error.value = ''
  notice.value = ''
  acceptedTaskId.value = ''
  void refreshSessions()
}
function showFiles() {
  tab.value = 'files'
  void refreshChat()
}
function showConversationUpdates() {
  screen.value = 'conversation'
  tab.value = 'chat'
  selectedTaskId.value = ''
  if (activeTask.value?.state === 'waiting_user') showTaskPanel.value = true
  else void bottom()
}
async function refreshChat(initial = false) {
  if (!connected.value || !selected.value || !['conversation', 'preview'].includes(screen.value))
    return
  const id = selected.value.id,
    epoch = selectionEpoch,
    key = `${epoch}:${id}`
  if (pollingKey === key) return
  pollingKey = key
  try {
    const results = await Promise.allSettled([
      client.rpc('messages.history', { sessionId: id }),
      client.rpc('tasks.list', { sessionId: id }),
      client.rpc('results.list', { sessionId: id }),
    ])
    if (!isCurrent(id, epoch)) return
    if (results[0].status === 'fulfilled') {
      hostOnline.value = true
      const nextMessages = normalizeHistory(results[0].value?.messages)
      const previousLast = messages.value[messages.value.length - 1]
      const nextLast = nextMessages[nextMessages.length - 1]
      const changed =
        nextLast && (previousLast?.id !== nextLast.id || previousLast?.text !== nextLast.text)
      const follow =
        initial ||
        (chatAtBottom.value &&
          screen.value === 'conversation' &&
          tab.value === 'chat' &&
          !settingsOpen.value)
      if (!initial && changed) hasNewMessages.value = !follow
      messages.value = nextMessages
      if (
        ['新对话', '新会话', 'New conversation', 'New session'].includes(selected.value?.title) &&
        messages.value.some((message) => message.role === 'user')
      )
        void refreshSessions()
      durable.value.history[keyFor(id)] = messages.value
      durable.save()
      historyMore.value = results[0].value?.hasMore === true
      syncError.value = ''
      if (initial || (changed && follow)) void bottom()
    } else {
      if (canQueueOffline(results[0].reason)) hostOnline.value = false
      syncError.value = userError(results[0].reason)
    }
    tasksAvailable.value = results[1].status === 'fulfilled'
    if (results[1].status === 'fulfilled') tasks.value = results[1].value?.tasks || []
    if (results[2].status === 'fulfilled') {
      artifacts.value = results[2].value?.artifacts || []
      records.value = taskResultSummaries(results[2].value?.records || [])
      resultsError.value = ''
    } else resultsError.value = '成果暂时无法同步，请确认电脑连接后重试。'
  } catch (reason) {
    if (isCurrent(id, epoch)) syncError.value = userError(reason)
  } finally {
    if (pollingKey === key) pollingKey = ''
    if (isCurrent(id, epoch)) loadingChat.value = false
  }
}
async function send() {
  if (
    !selected.value ||
    readOnly.value ||
    sending.value ||
    pendingDraft.value ||
    !draft.value.trim()
  )
    return
  const id = selected.value.id,
    epoch = selectionEpoch,
    key = keyFor(id)
  let command
  try {
    ledger.set(key, draft.value)
    command = ledger.prepare(key)
  } catch (reason) {
    setError(reason)
    return
  }
  sending.value = true
  acceptedTaskId.value = ''
  error.value = ''
  notice.value = '正在等待电脑接收…'
  try {
    if (command.expiresAt <= Date.now()) throw new Error('OUTBOX_EXPIRED')
    const receipt = await deliverCommand(client, id, command)
    ledger.acknowledge(key, command.requestId)
    if (!isCurrent(id, epoch)) return
    draft.value = ledger.get(key)
    selectedTaskId.value = ''
    acceptedTaskId.value = receipt.taskId
    notice.value = receipt.duplicate ? '电脑已接收这条请求。' : '电脑已接收，正在准备处理。'
    await refreshChat()
    void bottom()
  } catch (reason) {
    if (isCurrent(id, epoch)) {
      notice.value = ''
      if (canQueueOffline(reason) && remoteMode.value && remoteServer && chosenRemote.value) {
        try {
          await enqueueRemote(remoteServer, chosenRemote.value, id, command, durable)
          notice.value = '已加密保存到服务器，等待电脑接收。'
          error.value = ''
        } catch (queueError) {
          if (!canQueueOffline(queueError)) blockCommand(durable, command, queueError)
          setError(queueError)
        }
      } else {
        if (!canQueueOffline(reason)) blockCommand(durable, command, reason)
        setError(reason)
      }
    }
  } finally {
    sending.value = false
    updateOutbox()
  }
}
async function flushOutbox() {
  if (flushing || sending.value || !connected.value || !client.hostId) return
  flushing = true
  const hostId = client.hostId,
    remoteHost = chosenRemote.value
  try {
    for (const queued of durable.list()) {
      if (client.hostId !== hostId || transferBusy.value) break
      if (!queued.key.startsWith(`${hostId}|`) || queued.status === 'blocked') continue
      const sessionId = queued.key.slice(hostId.length + 1)
      try {
        if (queued.expiresAt <= Date.now()) throw new Error('OUTBOX_EXPIRED')
        if (sessions.value.find((item) => item.id === sessionId)?.kind === 'file')
          throw new Error('EDITOR_REQUIRED')
        const receipt = await deliverCommand(client, sessionId, queued)
        ledger.acknowledge(queued.key, queued.requestId)
        if (client.hostId === hostId && selected.value?.id === sessionId) {
          draft.value = ledger.get(queued.key)
          acceptedTaskId.value = receipt.taskId
          notice.value = '电脑已接收，正在同步任务状态。'
        }
      } catch (reason) {
        if (client.hostId !== hostId || reason?.code === 'STALE_CONNECTION') break
        if (!canQueueOffline(reason)) blockCommand(durable, queued, reason)
        else if (remoteMode.value && remoteServer && remoteHost) {
          try {
            await enqueueRemote(remoteServer, remoteHost, sessionId, queued, durable)
          } catch (queueError) {
            if (!canQueueOffline(queueError)) blockCommand(durable, queued, queueError)
          }
        }
      }
    }
  } finally {
    flushing = false
    updateOutbox()
    void syncRemoteReceipts()
  }
}
async function syncRemoteReceipts() {
  if (!remoteServer || syncingReceipts) return
  syncingReceipts = true
  const server = remoteServer,
    target = chosenRemote.value
  try {
    const result = await server.api.courier('receipts', { after: 0 })
    for (const receipt of result.items) {
      const queued = durable.value.queue[receipt.requestId]
      const key = `${server.api.baseUrl}|${receipt.id}`
      const previous = durable.value.receipts[key]
      durable.value.receipts[key] = {
        ...receipt,
        title: queued?.text?.slice(0, 100) || previous?.title || '大狗任务',
      }
      durable.save()
      if (matchesQueuedReceipt(queued, receipt, server.api.baseUrl) && receipt.taskId) {
        ledger.acknowledge(queued.key, receipt.requestId)
        if (
          remoteServer === server &&
          chosenRemote.value === receipt.target &&
          selected.value?.id === receipt.sessionId
        )
          draft.value = ledger.get(queued.key)
      }
      if (['completed', 'failed', 'waiting_user', 'interrupted'].includes(receipt.state))
        globalThis.BigDogNative?.notifyTask(
          key + ':' + receipt.revision,
          '大狗任务有更新',
          '打开应用查看任务结果或待确认事项',
        )
      await server.api.courier('ack', { id: receipt.id, revision: receipt.revision })
    }
    if (remoteServer === server && chosenRemote.value === target)
      delivered.value = recentReceipts(durable.value.receipts, server.api.baseUrl, target)
    updateOutbox()
  } catch {
    /* A delivery acknowledgement is retried after durable local storage succeeds. */
  } finally {
    syncingReceipts = false
  }
}
async function taskDecision(action, task = activeTask.value) {
  if (!task || !selected.value || decisionBusy.value) return
  const sessionId = selected.value.id,
    epoch = selectionEpoch
  decisionBusy.value = true
  try {
    const confirmed = await new Promise((resolve) =>
      uni.showModal({
        title: action === 'cancel' ? '停止这条请求？' : '确认任务操作',
        content: `“${taskTitle(task)}”\n${action === 'answer' ? '提交补充信息后继续。' : { pause: '暂停此任务。', resume: '继续此任务。', cancel: '只停止这条请求，其他任务不受影响。', retry: '重试此任务。', reconcile: '核对结果后继续此任务。' }[action]}`,
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      }),
    )
    if (!confirmed || !isCurrent(sessionId, epoch)) return
    const params = {
      sessionId,
      taskId: task.id,
      requestId: newRequestId(),
      expectedRevision: task.revision,
    }
    if (action === 'answer') {
      if (!decisionText.value.trim()) return
      await client.rpc('tasks.answer', {
        ...params,
        confirmationId: task.confirmation.id,
        answer: decisionText.value.trim(),
      })
      decisionText.value = ''
    } else
      await client.rpc('tasks.control', {
        ...params,
        action,
        ...(action === 'reconcile' ? { reviewed: true } : {}),
      })
    if (isCurrent(sessionId, epoch)) selectedTaskId.value = ''
    if (isCurrent(sessionId, epoch)) acceptedTaskId.value = task.id
    await refreshChat()
  } catch (reason) {
    setError(reason)
  } finally {
    decisionBusy.value = false
  }
}
async function approveTask(permission, allowed) {
  const task = activeTask.value
  if (!task || !selected.value || decisionBusy.value) return
  const sessionId = selected.value.id,
    epoch = selectionEpoch
  decisionBusy.value = true
  try {
    await client.rpc('tasks.approve', {
      sessionId,
      taskId: task.id,
      confirmationId: task.confirmation.id,
      expectedRevision: task.revision,
      permissionId: permission.id,
      allowed,
    })
    if (isCurrent(sessionId, epoch)) {
      acceptedTaskId.value = task.id
      notice.value = allowed
        ? '已允许这次操作，正在同步执行状态。'
        : '已拒绝这次操作，正在同步任务状态。'
      await refreshChat()
    }
  } catch (reason) {
    setError(reason)
  } finally {
    decisionBusy.value = false
  }
}
async function openArtifact(artifact) {
  if (!selected.value || downloadingId.value) return
  const id = selected.value.id,
    epoch = selectionEpoch
  downloadingId.value = artifact.id
  error.value = ''
  previewImage.value = ''
  pdfContent.value = ''
  pdfPage.value = 0
  pdfPages.value = 0
  previewHint.value =
    records.value.find((record) => record.files?.some((file) => file.name === artifact.name))
      ?.outcome === 'partial'
      ? '这份成果只完成了部分操作；若页面为空，请返回成果记录核对尚未写入的内容。'
      : ''
  try {
    if (globalThis.BigDogNative) {
      let file = artifact
      const type = documentFileType(artifact)
      if (type && type !== 'pdf')
        file = await client.rpc('artifacts.preview', { sessionId: id, artifactId: artifact.id })
      const bytes = await client.readArtifact(id, file)
      if (!isCurrent(id, epoch)) return
      previewName.value = artifact.name
      previewText.value = ''
      if (file.mime.startsWith('text/') || /\.(md|txt|csv|json|html?)$/i.test(file.name))
        previewText.value = new TextDecoder().decode(bytes)
      else {
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        const encoded = btoa(binary)
        if (file.mime === 'application/pdf') {
          pdfContent.value = encoded
          await turnPdf(0)
        } else if (file.mime.startsWith('image/'))
          previewImage.value = `data:${file.mime};base64,${encoded}`
        else throw new Error('PREVIEW_UNSUPPORTED')
      }
      screen.value = 'preview'
      return
    }
    const url = client.artifactUrl(id, artifact.id)
    const textFile =
      /^text\//.test(artifact.mime || '') ||
      /\.(txt|md|json|csv|log|html?|xml)$/i.test(artifact.name)
    if (textFile) {
      if (artifact.bytes > 2 * 1024 * 1024) throw new Error('FILE_TOO_LARGE')
      const result = await uniRequest({
        url,
        method: 'GET',
        timeout: 15000,
        header: client.authorization(),
        dataType: 'text',
        responseType: 'text',
      })
      if (result.statusCode !== 200) throw new Error('DOWNLOAD_FAILED')
      if (!isCurrent(id, epoch)) return
      previewText.value = String(result.data)
      previewName.value = artifact.name
      screen.value = 'preview'
      return
    }
    const result = await new Promise((resolve, reject) =>
      uni.downloadFile({
        url,
        header: client.authorization(),
        timeout: 60000,
        success: resolve,
        fail: reject,
      }),
    )
    if (result.statusCode !== 200) throw new Error('DOWNLOAD_FAILED')
    if (!isCurrent(id, epoch)) return
    if (/^image\//.test(artifact.mime || '') || /\.(png|jpe?g|webp|gif)$/i.test(artifact.name)) {
      uni.previewImage({ urls: [result.tempFilePath], current: result.tempFilePath })
    } else {
      const fileType = documentFileType(artifact)
      if (!fileType) throw new Error('UNSUPPORTED_DOCUMENT')
      // #ifdef H5
      throw new Error('DOCUMENT_H5_UNSUPPORTED')
      // #endif
      let filePath = result.tempFilePath
      // #ifdef APP-PLUS
      filePath = await ensureDocumentExtension(filePath, fileType, plus, newRequestId)
      // #endif
      if (!isCurrent(id, epoch)) return
      await new Promise((resolve, reject) =>
        uni.openDocument({
          filePath,
          fileType,
          showMenu: true,
          success: resolve,
          fail: reject,
        }),
      )
    }
  } catch (reason) {
    if (isCurrent(id, epoch)) {
      const fileErrors = {
        FILE_TOO_LARGE: '文件较大，请先在电脑查看。',
        UNSUPPORTED_DOCUMENT: '这种文件暂不支持手机阅读，请在电脑查看。',
        DOCUMENT_H5_UNSUPPORTED:
          '浏览器联调版暂不支持 PDF 和 Office 原件阅读，请在 Android 客户端或电脑查看。',
        DOCUMENT_PATH_FAILED: '文件已下载，但未能准备阅读副本，请重试或在电脑查看。',
        PDF_PREVIEW_FAILED: 'PDF 预览失败，请在电脑核对文件是否加密或损坏。',
        PREVIEW_FAILED: '电脑未能生成文件预览，请稍后重试或在电脑查看。',
      }
      error.value =
        fileErrors[reason?.message] ||
        (nativeReader
          ? '暂时无法读取文件预览，请确认电脑连接仍有效。'
          : '暂时无法打开该文件。PDF 和 Office 原件需要设备上有相应阅读应用；也请确认电脑连接仍有效。')
    }
  } finally {
    downloadingId.value = ''
  }
}
let catalogPollTick = 0
function startPolling() {
  clearInterval(timer)
  timer = setInterval(() => {
    if (!connected.value || transferBusy.value) return
    void reconnectRemote()
    void flushOutbox()
    void syncRemoteReceipts()
    void syncPush()
    routeLabel.value = remoteLink?.stats()?.mode || ''
    if (screen.value === 'sessions' || drawerOpen.value || ++catalogPollTick % 5 === 0)
      void refreshSessions()
    if (screen.value === 'conversation' || screen.value === 'preview') void refreshChat()
  }, 1800)
}
let restoredConnection = false
async function restoreConnection() {
  if (restoredConnection || connected.value || !durable.value.connection) return
  restoredConnection = true
  await reconnectSaved()
  if (!connected.value && error.value)
    error.value = '上次连接的电脑暂时不可达。可重连，或扫描新的电脑二维码。'
}
onShow(() => {
  startPolling()
  void restoreConnection()
})
onHide(() => clearInterval(timer))
const onNativeBack = () => {
  if (
    aboutOpen.value ||
    settingsOpen.value ||
    showTaskPanel.value ||
    showOutbox.value ||
    drawerOpen.value ||
    screen.value === 'conversation' ||
    screen.value === 'preview'
  )
    back()
  else globalThis.BigDogNative?.closeApp()
}
const onNativeForeground = () => {
  startPolling()
  void restoreConnection()
}
const onNativeBackground = () => clearInterval(timer)
const onEscape = (event) => {
  if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) back()
}
globalThis.addEventListener?.('keydown', onEscape)
globalThis.addEventListener?.('bigdog-back', onNativeBack)
globalThis.addEventListener?.('bigdog-foreground', onNativeForeground)
globalThis.addEventListener?.('bigdog-background', onNativeBackground)
onUnmounted(() => {
  clearInterval(timer)
  systemTheme?.removeEventListener?.('change', updateNativeAppearance)
  globalThis.removeEventListener?.('keydown', onEscape)
  client.disconnect()
  globalThis.removeEventListener?.('bigdog-back', onNativeBack)
  globalThis.removeEventListener?.('bigdog-foreground', onNativeForeground)
  globalThis.removeEventListener?.('bigdog-background', onNativeBackground)
})
</script>

<template>
  <view class="app-shell" :data-theme="theme" :class="{ 'large-text': largeText }">
    <view
      v-if="connected"
      class="drawer-backdrop"
      :class="{ open: drawerOpen }"
      @click="drawerOpen = false"
    />
    <view
      v-if="connected"
      class="sessions-sidebar"
      :class="{ open: drawerOpen }"
      aria-label="对话列表"
    >
      <SessionDrawer
        :sessions="sessions"
        :selected-id="selected?.id"
        :host-name="hostName"
        :online="hostOnline"
        :busy="busy"
        @open="openSession"
        @new="createSession"
        @refresh="refreshSessions"
        @settings="openSettings"
        @close="drawerOpen = false"
      />
    </view>
    <view class="main-pane">
      <view class="topbar">
        <button
          v-if="settingsOpen || screen === 'preview'"
          class="icon-button glass"
          aria-label="返回"
          @click="back"
        >
          <AppIcon name="back" />
        </button>
        <button
          v-else-if="connected"
          class="icon-button glass menu-button"
          aria-label="打开对话列表"
          @click="openDrawer"
        >
          <AppIcon name="menu" />
        </button>
        <view class="title-pill">
          <text class="brand-title">{{
            settingsOpen
              ? 'AI 大狗'
              : screen === 'preview'
                ? previewName
                : screen === 'conversation'
                  ? selectedTitle
                  : 'AI 大狗'
          }}</text>
          <text class="brand-subtitle"
            ><text class="status-dot" :class="{ online: hostOnline }" />{{
              connected ? (hostOnline ? hostName : '等待电脑上线') : '手机与电脑，同一份对话'
            }}</text
          >
        </view>
        <view class="topbar-spacer" />
        <button
          v-if="
            connected &&
            !settingsOpen &&
            (screen === 'preview' || (screen === 'conversation' && tab === 'files')) &&
            (hasNewMessages || activeTask?.state === 'waiting_user')
          "
          class="update-button"
          @click="showConversationUpdates"
        >
          {{ activeTask?.state === 'waiting_user' ? '待确认' : '新消息' }}
        </button>
        <button
          v-if="connected && !settingsOpen && screen !== 'preview'"
          class="icon-button glass"
          aria-label="新对话"
          :disabled="busy"
          @click="createSession"
        >
          <AppIcon name="new" />
        </button>
      </view>
      <text
        v-if="connected && (error || syncError) && !showTaskPanel && !showOutbox"
        class="error banner"
        role="alert"
        >{{ error || syncError }}</text
      >
      <view v-if="connected && queueItems.length && !settingsOpen" class="outbox-banner"
        ><button @click="showOutbox = true">
          {{ queuedCount ? `${queuedCount} 条等待接收` : ''
          }}{{ queuedCount && blockedCount ? ' · ' : ''
          }}{{ blockedCount ? `${blockedCount} 条需处理` : '' }} · 查看
        </button></view
      >

      <scroll-view v-if="settingsOpen" scroll-y class="main-scroll"
        ><view class="reading-column">
          <text class="page-headline">设置</text>
          <view class="settings-group">
            <view class="settings-row"
              ><view class="host-icon"><AppIcon name="computer" /></view
              ><view class="session-copy"
                ><text class="session-title">{{ hostName }}</text
                ><text class="muted">{{
                  hostOnline ? '已连接 · 任务由电脑执行' : '电脑离线 · 待发请求会保留'
                }}</text></view
              ></view
            >
            <button class="settings-row" @click="disconnect">
              <text class="row-label">更换或断开电脑</text><AppIcon name="chevron" />
            </button>
          </view>
          <text class="settings-label">消息</text
          ><view class="settings-group">
            <button class="settings-row" @click="showOutbox = true">
              <AppIcon name="inbox" /><text class="row-label">待发与回执</text
              ><text class="settings-value">{{
                queueItems.length ? `${queueItems.length} 条待处理` : '没有待发请求'
              }}</text
              ><AppIcon name="chevron" />
            </button>
            <button v-if="remoteMode" class="settings-row" @click="enablePush">
              <AppIcon name="bell" /><text class="row-label">任务推送</text
              ><AppIcon name="chevron" />
            </button>
            <text v-if="pushStatus" class="settings-help" role="status">{{ pushStatus }}</text>
          </view>
          <text class="settings-label">外观</text
          ><view class="settings-group">
            <view class="settings-row"
              ><AppIcon name="sun" /><text class="row-label">主题</text
              ><text class="settings-value">雾蓝</text></view
            >
            <view class="segmented" role="group" aria-label="主题"
              ><button
                v-for="choice in [
                  { value: 'system', label: '跟随系统' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]"
                :key="choice.value"
                :class="{ selected: theme === choice.value }"
                @click="theme = choice.value"
              >
                {{ choice.label }}
              </button></view
            >
            <view class="settings-row"
              ><text class="row-label">对话字号</text
              ><text class="settings-value">含文件正文</text></view
            ><view class="segmented" role="group" aria-label="对话字号"
              ><button :class="{ selected: !largeText }" @click="largeText = false">标准</button
              ><button :class="{ selected: largeText }" @click="largeText = true">大</button></view
            >
          </view>
          <text class="settings-label">关于</text
          ><view class="settings-group">
            <button class="settings-row" @click="aboutOpen = true">
              <AppIcon name="info" /><text class="row-label">关于 AI 大狗</text
              ><text class="settings-value">0.1.4</text><AppIcon name="chevron" />
            </button>
            <button class="settings-row" @click="openLicenses">
              <text class="row-label">开源致谢</text><AppIcon name="chevron" />
            </button>
          </view> </view
      ></scroll-view>
      <scroll-view v-else-if="!connected" scroll-y class="main-scroll">
        <view class="connect-card">
          <image
            v-if="!scannedInvitation"
            src="/static/dog-welcome.png"
            class="welcome-dog"
            mode="aspectFit"
          />
          <text class="headline">{{ scannedInvitation ? '已识别电脑' : '大狗，随时在身边' }}</text>
          <text v-if="!scannedInvitation" class="description"
            >电脑打开「设置 → 手机协作」，生成二维码。扫码后继续对话、查看任务和文件。</text
          >
          <view v-if="!scannedInvitation" class="pairing-actions">
            <button class="primary" :disabled="busy" @click="scanInvitation('camera')">
              <AppIcon name="scan" />扫描电脑二维码
            </button>
            <button :disabled="busy" @click="scanInvitation('image')">
              <AppIcon name="image" />从图片识别
            </button>
          </view>
          <view v-if="!scannedInvitation" class="field">
            <text>或粘贴配对码</text>
            <textarea
              v-model="invitationText"
              :disabled="busy"
              :maxlength="2048"
              auto-height
              placeholder="粘贴电脑复制的完整配对码，无需填写 IP"
              @input="scannedInvitation = null"
            />
          </view>
          <view v-if="scannedInvitation" class="pairing-target">
            <text class="session-title">连接「{{ scannedInvitation.name }}」</text>
            <text class="muted">{{ scannedInvitation.server }}</text>
            <text class="muted">这台手机可查看对话和文件，并向电脑委派任务。</text>
          </view>
          <text v-if="error" class="error" role="alert">{{ error }}</text>
          <text v-if="busy && pairingProgress" class="muted" role="status">{{
            pairingProgress
          }}</text>
          <button
            v-if="invitationText.trim()"
            class="primary"
            :disabled="busy"
            @click="acceptInvitation"
          >
            {{ busy ? '正在连接…' : scannedInvitation ? '确认连接这台电脑' : '识别配对码' }}
          </button>
          <button
            v-if="scannedInvitation"
            class="quiet-button"
            :disabled="busy"
            @click="replaceInvitation"
          >
            更换二维码或配对码
          </button>
          <button v-if="chosenRemote && !invitationText" :disabled="busy" @click="reconnectSaved">
            {{ busy ? '正在连接…' : '重连上次的电脑' }}
          </button>
          <button class="quiet-button" @click="advancedConnection = !advancedConnection">
            {{ advancedConnection ? '收起高级连接' : '高级连接' }}
          </button>
          <view v-if="advancedConnection" class="remote-fields">
            <button class="quiet-button" @click="remoteMode = !remoteMode">
              {{ remoteMode ? '切换本地直连' : '使用远程服务器' }}
            </button>
            <view v-if="remoteMode" class="remote-fields">
              <view class="field"
                ><text>服务器</text
                ><input
                  v-model="serverAddress"
                  placeholder="https://remote.example.com"
                  :disabled="busy"
              /></view>
              <view class="field"
                ><text>连接账号</text
                ><input v-model="remoteAccount" placeholder="自部署服务账号" :disabled="busy"
              /></view>
              <view class="field"
                ><text>连接密码</text
                ><input
                  v-model="remotePassword"
                  password
                  placeholder="已授权设备可留空"
                  :disabled="busy"
              /></view>
              <button :disabled="busy" @click="discoverRemote">查看我的电脑</button>
              <button
                v-for="device in remoteDevices"
                :key="device.deviceId"
                @click="chosenRemote = device.deviceId"
              >
                {{ chosenRemote === device.deviceId ? '✓ ' : '' }}{{ device.name }} ·
                {{ device.online ? '在线' : '离线' }}
              </button>
            </view>
            <view v-else class="field"
              ><text>电脑地址</text
              ><input
                v-model="address"
                :disabled="busy"
                placeholder="http://127.0.0.1:48219"
                :maxlength="200"
            /></view>
            <view class="field"
              ><text>配对码</text
              ><input
                v-model="pairingCode"
                :disabled="busy"
                placeholder="首次连接输入配对码，已配对可留空"
                :maxlength="128"
            /></view>
            <view class="field"
              ><text>设备名称</text
              ><input v-model="deviceName" :disabled="busy" placeholder="我的手机" :maxlength="80"
            /></view>
            <button class="primary" :disabled="busy" @click="connect">
              {{ busy ? '正在连接…' : '连接电脑' }}
            </button>
            <text class="footnote"
              >首次连接需要电脑提供的配对码；之后使用本机设备密钥恢复连接。</text
            >
          </view>
        </view>
      </scroll-view>

      <scroll-view v-else-if="screen === 'sessions'" scroll-y class="main-scroll"
        ><view class="reading-column">
          <text v-if="notice" class="notice">{{ notice }}</text>
          <view v-if="!attentionSessions.length" class="empty welcome"
            ><image src="/static/dog-welcome.png" mode="aspectFit" /><text class="empty-title"
              >今天想做些什么？</text
            ><text>让电脑处理任务，随时在这里查看进展。</text
            ><button class="primary" :disabled="busy" @click="createSession">
              开始新对话
            </button></view
          >
          <view v-if="attentionSessions.length" class="settings-group"
            ><text class="settings-label">需要你确认 · {{ attentionSessions.length }}</text
            ><button
              v-for="session in attentionSessions"
              :key="session.id"
              class="settings-row"
              @click="openAttentionSession(session)"
            >
              <AppIcon name="tasks" /><view class="session-copy"
                ><text class="session-title">{{ session.title }}</text
                ><text class="muted">{{ session.attention.title }}</text></view
              ><AppIcon name="chevron" /></button
          ></view>
          <view v-if="sessions.length"
            ><text class="recent-heading">最近对话</text
            ><button
              v-for="session in sessions.slice(0, 5)"
              :key="session.id"
              class="recent-session"
              @click="openSession(session)"
            >
              <AppIcon :name="session.kind === 'file' ? 'file' : 'chat'" /><view
                class="session-copy"
                ><text class="session-title">{{ session.title || '新对话' }}</text
                ><text v-if="session.kind === 'file'" class="muted">文件对话 · 只读</text></view
              ><AppIcon name="chevron" /></button
          ></view> </view
      ></scroll-view>

      <template v-else-if="screen === 'preview'">
        <view class="preview-toolbar"
          ><text>{{
            pdfPages ? 'PDF / Office 只读预览' : previewImage ? '图片预览' : '文本预览'
          }}</text
          ><template v-if="pdfPages"
            ><button :disabled="pdfPage === 0" @click="turnPdf(-1)">上一页</button
            ><text>{{ pdfPage + 1 }} / {{ pdfPages }}</text
            ><button :disabled="pdfPage + 1 >= pdfPages" @click="turnPdf(1)">
              下一页
            </button></template
          ></view
        >
        <scroll-view scroll-y class="main-scroll"
          ><view class="reading-column"
            ><text v-if="previewHint" class="preview-note">{{ previewHint }}</text
            ><image
              v-if="previewImage"
              :src="previewImage"
              mode="widthFix"
              class="preview-image"
            /><text v-else class="file-text" selectable>{{ previewText }}</text></view
          ></scroll-view
        >
      </template>

      <template v-else>
        <view class="tabs"
          ><button :class="{ selected: tab === 'chat' }" @click="tab = 'chat'">对话</button
          ><button :class="{ selected: tab === 'files' }" @click="showFiles">
            成果与文件 <text v-if="artifacts.length">{{ artifacts.length }}</text>
          </button></view
        >
        <scroll-view
          v-show="tab === 'chat'"
          scroll-y
          class="chat-scroll message-scroller"
          :scroll-top="chatScrollTop"
          @scroll="onChatScroll"
          :scroll-into-view="scrollAnchor"
          :scroll-with-animation="false"
          ><view class="reading-column">
            <view v-if="loadingChat" class="empty"><text>正在同步对话…</text></view>
            <text v-if="historyMore" class="history-note"
              >当前显示最近 100 条消息，完整历史可在电脑查看。</text
            >
            <view v-if="!loadingChat && !messages.length" class="empty"
              ><image src="/static/dog-welcome.png" mode="aspectFit" /><text class="empty-title"
                >想让大狗帮你做什么？</text
              ><text>对话、记忆和文件与电脑保持一致。</text></view
            >
            <view
              v-for="message in messages"
              :key="message.id"
              class="message"
              :class="message.role"
              ><view v-if="message.role !== 'user'" class="message-role"
                ><image src="/static/dog-welcome.png" mode="aspectFit" /><text>AI 大狗</text></view
              ><view class="bubble"
                ><MessageContent v-if="message.role === 'assistant'" :text="message.text" /><text
                  v-else
                  selectable
                  >{{ message.text }}</text
                ></view
              ></view
            >
            <view id="message-bottom" class="message-bottom" /> </view
        ></scroll-view>
        <scroll-view v-show="tab === 'files'" scroll-y class="chat-scroll"
          ><view class="reading-column"
            ><text class="page-headline">成果与文件</text>
            <text v-if="resultsError" class="error banner" role="alert">{{ resultsError }}</text>
            <view v-if="!resultsError && !artifacts.length && !records.length" class="empty"
              ><text class="empty-title">还没有成果文件</text
              ><text>电脑完成任务后，可在这里查看成果。</text></view
            >
            <view
              v-for="artifact in artifacts"
              :key="artifact.id"
              class="file-card"
              role="button"
              tabindex="0"
              @keydown.enter="openArtifact(artifact)"
              @click="openArtifact(artifact)"
              ><text class="file-badge">{{
                artifact.name?.split('.').pop()?.slice(0, 5).toUpperCase() || 'FILE'
              }}</text
              ><view class="session-copy"
                ><text class="session-title">{{ artifact.name }}</text
                ><text class="muted"
                  >{{ Math.max(1, Math.round((artifact.bytes || 0) / 1024)) }} KB ·
                  {{ downloadingId === artifact.id ? '正在打开…' : '查看' }}</text
                ></view
              ><text class="chevron">›</text></view
            >
            <view v-for="(record, index) in records" :key="record.id || index" class="result-card"
              ><text class="session-title">{{
                resultLabels[record.outcome] || '任务成果记录'
              }}</text
              ><text class="muted">{{
                record.files?.map((file) => file.name).join('、') || '无文件变更'
              }}</text
              ><text class="muted">{{ new Date(record.occurredAt).toLocaleString() }}</text></view
            >
            <text class="reader-help">{{
              nativeReader
                ? '文本、图片与 PDF 可直接查看；Office 文件由电脑生成只读预览。'
                : '文本与图片可直接查看；PDF、Office 原件通过设备上的阅读应用打开。'
            }}</text>
            <view v-if="remoteMode && !readOnly" class="task-actions">
              <button @click="showTransfer = !showTransfer">
                {{ showTransfer ? '收起迁移设置' : '迁移到另一台电脑…' }}
              </button>
              <view v-if="showTransfer">
                <text>当前执行电脑：{{ hostName }}</text>
                <button
                  v-for="device in remoteDevices.filter((d) => d.deviceId !== chosenRemote)"
                  :key="device.deviceId"
                  @click="transferTarget = device.deviceId"
                >
                  {{ transferTarget === device.deviceId ? '✓ ' : '' }}{{ device.name }}
                </button>
                <input v-model="transferCode" placeholder="目标电脑首次配对码，已配对可留空" />
                <button :disabled="transferBusy || !transferTarget" @click="transferSession">
                  迁移会话、记忆与成果
                </button>
              </view>
              <text v-if="transferProgress">{{ transferProgress }}</text>
            </view>
          </view></scroll-view
        >

        <button v-if="tab === 'chat' && hasNewMessages" class="latest-button" @click="bottom">
          新消息 · 查看最新 ↓
        </button>
        <view class="composer-deck">
          <button
            v-if="tasks.length || !tasksAvailable"
            class="task-dock"
            :class="{ 'needs-action': activeTask?.state === 'waiting_user' }"
            @click="openTasks"
          >
            <text
              class="status-dot"
              :class="
                tasksAvailable
                  ? taskOutcome(activeTask, records) || activeTask?.state
                  : 'unavailable'
              "
            /><text>{{ taskLabel }}</text
            ><text class="dock-title muted">{{ activeTask ? taskTitle(activeTask) : '' }}</text
            ><text class="dock-action">{{
              activeTask?.state === 'waiting_user' ? '核对并继续' : '任务详情'
            }}</text
            ><AppIcon name="chevron" />
          </button>
          <view v-if="tab === 'chat' && readOnly" class="composer readonly-note"
            ><text>文件对话在手机只读。可新建 AI 大狗对话，告诉它需要处理的文件。</text
            ><text v-if="draft" selectable>已保留草稿：{{ draft }}</text
            ><button class="quiet-button" :disabled="busy" @click="createSession">
              新建 AI 大狗对话
            </button></view
          >
          <template v-else-if="tab === 'chat'">
            <text
              v-if="
                composerNotice &&
                (pendingDraft || !hostOnline || activeTask?.state === 'queued' || sending)
              "
              class="composer-note"
              role="status"
              >{{ composerNotice }}</text
            >
            <view class="composer">
              <textarea
                :value="draft"
                @input="saveDraft"
                :maxlength="8000"
                :auto-height="true"
                :cursor-spacing="16"
                :adjust-position="true"
                placeholder="告诉大狗你想做什么…"
                aria-label="消息" /><view class="composer-footer"
                ><button class="composer-context" @click="showFiles">
                  <AppIcon name="file" /><text
                    >文件{{ artifacts.length ? ` · ${artifacts.length}` : '' }}</text
                  ></button
                ><text class="muted">{{
                  sending ? '等待接收…' : pendingDraft ? '已保存待收' : '由电脑执行'
                }}</text
                ><button
                  class="primary send-button"
                  aria-label="发送消息"
                  :disabled="sending || pendingDraft || !draft.trim()"
                  @click="send"
                >
                  <AppIcon name="send" /></button></view
            ></view>
          </template>
        </view>
      </template>
    </view>
    <AppSheet v-if="showTaskPanel && selected" title="任务" @close="showTaskPanel = false">
      <text v-if="error || syncError" class="error banner" role="alert">{{
        error || syncError
      }}</text>
      <view class="task-actions"
        ><text class="session-title">{{ loadingChat ? '正在同步任务…' : taskLabel }}</text
        ><view class="task-buttons"
          ><button @click="showTaskList = !showTaskList">
            {{ showTaskList ? '收起列表' : `全部任务 ${tasks.length}` }}</button
          ><button @click="refreshChat">刷新状态</button
          ><button v-if="artifacts.length" @click="showTaskResults">
            查看成果 {{ artifacts.length }}
          </button></view
        ></view
      >
      <view class="task-panel">
        <view v-if="showTaskList" class="task-actions">
          <button class="quiet-button" @click="chooseTask('')">自动定位需要处理的任务</button>
          <view v-for="task in taskChoices" :key="task.id" class="task-choice">
            <button @click="chooseTask(task.id)">
              {{ task.id === activeTask?.id ? '当前 · ' : '' }}{{ taskStateLabel(task, records) }} ·
              {{ taskTitle(task) }}
            </button>
            <button
              v-if="task.state === 'queued'"
              :disabled="decisionBusy"
              @click="taskDecision('cancel', task)"
            >
              停止这条排队请求
            </button>
          </view>
        </view>
        <view v-if="activeTask" class="task-caption">
          <text>当前任务：{{ taskTitle(activeTask) }}</text>
          <text v-if="predecessor"
            >正在等待前一任务“{{ taskTitle(predecessor) }}”，请先处理该任务。</text
          >
          <button v-if="predecessor" @click="chooseTask(predecessor.id)">查看前一任务</button>
          <text
            v-else-if="
              activeTask.state === 'waiting_user' && tasks.some((task) => task.state === 'queued')
            "
            >后续请求已排队，先完成下方确认即可继续。</text
          >
        </view>
        <view v-if="taskOutcome(activeTask, records) === 'partial'" class="task-actions">
          <text>这项任务只完成了部分操作，请查看答复和成果记录中的剩余事项。</text>
          <button @click="continueTask">继续未完成事项</button>
        </view>
        <view
          v-if="activeTask && !['completed', 'cancelled'].includes(activeTask.state)"
          class="task-actions"
        >
          <template v-if="activeTask.state === 'failed' && retryBudgetExhausted(activeTask)">
            <text>本次任务的执行额度已用尽。可准备新的请求，核对后再发送。</text>
            <button @click="continueTask">准备新的请求</button>
          </template>
          <text v-else-if="activeTask.reason">{{ taskReason(activeTask.reason) }}</text>
          <view
            v-for="permission in activeTask.permissions || []"
            :key="permission.id"
            class="permission-block"
            ><text class="session-title">{{ permissionCopy(permission).title }}</text
            ><text selectable class="permission-preview">{{
              permissionCopy(permission).description
            }}</text
            ><text v-if="permission.expiresAt" class="muted">{{
              permission.expiresAt <= Date.now()
                ? '确认已过期，正在同步任务状态…'
                : `请在 ${new Date(permission.expiresAt).toLocaleTimeString()} 前确认；过期后可重试任务。`
            }}</text
            ><text v-else-if="permission.persistent" class="muted"
              >可稍后确认，执行前会重新核对目标状态。</text
            ><view class="task-buttons"
              ><button :disabled="decisionBusy" @click="approveTask(permission, false)">拒绝</button
              ><button
                :disabled="
                  decisionBusy || (permission.expiresAt && permission.expiresAt <= Date.now())
                "
                class="primary"
                @click="approveTask(permission, true)"
              >
                允许这一次
              </button></view
            ></view
          >
          <view v-if="activeTask.confirmation?.kind === 'clarification'">
            <text>{{ activeTask.confirmation.text }}</text>
            <textarea
              v-model="decisionText"
              placeholder="补充这项任务需要的信息"
              :maxlength="8000"
            />
            <button
              :disabled="decisionBusy || !decisionText.trim()"
              @click="taskDecision('answer')"
            >
              答复并继续
            </button>
          </view>
          <view class="task-buttons">
            <button
              v-if="['queued', 'preparing', 'running', 'verifying'].includes(activeTask.state)"
              :disabled="decisionBusy"
              @click="taskDecision('pause')"
            >
              暂停
            </button>
            <button
              v-if="activeTask.state === 'paused'"
              :disabled="decisionBusy"
              @click="taskDecision('resume')"
            >
              继续
            </button>
            <button
              v-if="activeTask.state === 'failed'"
              :disabled="decisionBusy || retryBudgetExhausted(activeTask)"
              @click="taskDecision('retry')"
            >
              重试
            </button>
            <button
              v-if="!['completed', 'failed', 'cancelled'].includes(activeTask.state)"
              :disabled="decisionBusy"
              @click="taskDecision('cancel')"
            >
              停止任务
            </button>
          </view>
        </view>
      </view>

      <view v-if="!loadingChat && !activeTask" class="empty"><text>当前没有任务</text></view>
    </AppSheet>
    <AppSheet v-if="showOutbox" title="待发与回执" @close="showOutbox = false">
      <text v-if="error" class="error banner" role="alert">{{ error }}</text>
      <view v-if="!queueItems.length" class="empty"><text>没有待发请求</text></view>
      <view v-for="item in queueItems" :key="item.requestId" class="outbox-item"
        ><text class="session-title">{{ outboxSession(item) }}</text
        ><text selectable>{{ item.text }}</text
        ><text class="muted">{{
          item.status === 'blocked'
            ? userError({ code: item.errorCode })
            : item.status === 'server-queued'
              ? '已保存到服务器，等待电脑接收，无需重发。'
              : '已保存在手机，等待恢复连接并核对接收状态。'
        }}</text
        ><button v-if="item.status === 'blocked' && !item.envelope" @click="returnDraft(item)">
          停止重试，保留为草稿</button
        ><text v-else-if="item.status === 'blocked'" class="muted"
          >此请求已交给服务器，请先核对接收状态，避免重复执行。</text
        ></view
      >
      <view v-if="delivered.length" class="task-actions"
        ><text class="session-title">最近的离线请求回执</text
        ><view v-for="item in delivered.slice(0, 10)" :key="item.id" class="receipt-row"
          ><text>{{ item.title }}</text
          ><text class="muted">{{ taskLabels[item.state] || '等待接收' }}</text></view
        ></view
      >
    </AppSheet>
    <AppSheet v-if="aboutOpen" title="关于 AI 大狗" @close="aboutOpen = false"
      ><view class="task-actions"
        ><text class="session-title">AI 大狗 · 手机端 0.1.4</text
        ><text>连接电脑，继续对话、处理任务确认、查看 Office 和 PDF 成果。</text
        ><text class="muted"
          >界面结构与视觉参照 dsh-Go；使用 uni-app 实现并接入大狗 Session 与任务协议。dsh-Go 的
          Flutter 源码、手机自动化和本机引擎未包含在本客户端。</text
        ><text selectable class="muted">https://github.com/ccch1mneyyy/dsh-Go</text
        ><text class="muted"
          >第三方依赖的完整许可随 Android 安装包提供，可在「开源致谢」中阅读。</text
        ></view
      ></AppSheet
    >
  </view>
</template>
