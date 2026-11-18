import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../locale'
import { settingsCopy } from '../settings-copy'
import type { RemoteAdminStatus } from '../../../shared/mobile-host-api'

export function RemotePanel() {
  const { lang } = useI18n(),
    zh = lang.startsWith('zh'),
    copy = settingsCopy(lang)
  const [status, setStatus] = useState<RemoteAdminStatus>()
  const [invite, setInvite] = useState<{ code: string; expiresAt: number; qrDataUrl?: string }>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now)
  const alive = useRef(true),
    lock = useRef(false)
  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await window.aiOfficeRemote.status()
      if (alive.current) setStatus(next)
    } catch {
      if (alive.current)
        setError(
          zh ? '无法读取连接状态，请重试。' : 'Could not read connection status. Please retry.',
        )
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [zh])
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])
  useEffect(() => {
    if (!invite) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [invite])
  useEffect(() => {
    if (!invite) return
    let disposed = false,
      pending = false
    const timer = setInterval(async () => {
      if (pending) return
      pending = true
      try {
        const next = await window.aiOfficeRemote.status()
        if (!disposed) setStatus(next)
      } catch {
        /* Keep the invite usable through a transient status failure. */
      } finally {
        pending = false
      }
    }, 3000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [invite])
  const run = async (id: string, action: () => Promise<void>, failure: string) => {
    if (lock.current) return
    lock.current = true
    setBusy(id)
    setError('')
    setNotice('')
    try {
      await action()
    } catch {
      if (alive.current) setError(failure)
    } finally {
      lock.current = false
      if (alive.current) setBusy(null)
    }
  }
  const expired = !!invite && now >= invite.expiresAt
  const consumed = !!invite && status?.invitationState === 'used'
  return (
    <section className="set-remote">
      <h3 className="set-pane-title">{zh ? '手机协作' : 'Phone collaboration'}</h3>
      <p className="set-field-desc" role="status">
        {loading
          ? copy.loading
          : !status
            ? ''
            : status.enabled
              ? status.online
                ? zh
                  ? '远程服务已连接'
                  : 'Remote service connected'
                : zh
                  ? '本地连接已启用，远程服务未连接'
                  : 'Local connection enabled; remote service disconnected'
              : zh
                ? '尚未配置连接服务。完成配置后，可在这里配对手机。'
                : 'Connection service is not configured. Set it up before pairing your phone.'}
      </p>
      {status?.serverUrl && (
        <p className="set-field-desc set-remote-address">
          {status.name} · {status.serverUrl}
        </p>
      )}
      <div className="set-about-actions">
        <button
          className="set-btn primary"
          disabled={!status?.enabled || loading || !!busy}
          aria-busy={busy === 'invite'}
          onClick={() =>
            void run(
              'invite',
              async () => {
                const next = await window.aiOfficeRemote.invite()
                if (alive.current) {
                  setInvite(next)
                  setStatus((previous) => previous && { ...previous, invitationState: 'ready' })
                }
              },
              zh
                ? '未能生成配对码，请检查连接后重试。'
                : 'Could not create an invitation. Check the connection and retry.',
            )
          }
        >
          {busy === 'invite' ? copy.working : zh ? '生成手机配对码' : 'Create pairing invitation'}
        </button>
        <button
          className="set-btn"
          disabled={loading || !!busy}
          aria-busy={loading}
          onClick={() => void refresh()}
        >
          {loading ? copy.loading : zh ? '刷新状态' : 'Refresh status'}
        </button>
        <button
          className="set-btn"
          disabled={!!busy}
          onClick={() =>
            void run(
              'guide',
              () => window.aiOffice.openRemoteGuide(),
              zh ? '无法打开说明，请稍后重试。' : 'Could not open the guide. Please retry.',
            )
          }
        >
          {zh ? '配置说明' : 'Setup guide'}
        </button>
      </div>
      {invite && (
        <div className="set-remote-invite">
          {invite.qrDataUrl && !expired && !consumed && (
            <>
              <img
                className="set-remote-qr"
                src={invite.qrDataUrl}
                alt={zh ? '手机配对二维码' : 'Phone pairing QR code'}
              />
              <p>
                {zh
                  ? '手机打开 AI 大狗，点击「扫描电脑二维码」。'
                  : 'Open AI BigDog on your phone and scan this code.'}
              </p>
              <p className="set-field-desc">
                {zh
                  ? '也可复制完整配对码，粘贴到手机；无需输入服务器地址或账号。仅向自己的手机提供此邀请。'
                  : 'Or paste the full pairing code on your phone. No server address or account entry is needed. Share this invitation only with your own phone.'}
              </p>
            </>
          )}
          {invite.qrDataUrl ? (
            <details>
              <summary>{zh ? '查看完整配对码' : 'Show full pairing code'}</summary>
              <code>{invite.code}</code>
            </details>
          ) : (
            <code>{invite.code}</code>
          )}
          <p className="set-field-desc" role="status">
            {consumed
              ? zh
                ? '手机已配对，可在手机继续对话、查看任务和文件。'
                : 'Phone paired. Continue conversations and view tasks and files on your phone.'
              : expired
                ? zh
                  ? '配对码已过期，请重新生成。'
                  : 'Invitation expired. Create a new one.'
                : zh
                  ? `一次有效，有效期至 ${new Date(invite.expiresAt).toLocaleTimeString(lang)}。`
                  : `Single use, expires at ${new Date(invite.expiresAt).toLocaleTimeString(lang)}.`}
          </p>
          <button
            className="set-btn"
            disabled={expired || consumed || !!busy}
            aria-busy={busy === 'copy'}
            onClick={() =>
              void run(
                'copy',
                async () => {
                  await navigator.clipboard.writeText(invite.code)
                  if (alive.current) setNotice(copy.copied)
                },
                copy.copyFailed,
              )
            }
          >
            {notice === copy.copied ? copy.copied : zh ? '复制配对码' : 'Copy invitation'}
          </button>
          {invite.qrDataUrl && (
            <button
              className="set-btn"
              disabled={expired || consumed || !!busy}
              onClick={() =>
                void run(
                  'save-qr',
                  async () => {
                    if (await window.aiOfficeRemote.saveQr())
                      setNotice(
                        zh
                          ? '二维码已保存，可在手机从图片识别。'
                          : 'QR image saved. Open it from your phone.',
                      )
                  },
                  zh ? '二维码未能保存，请重试。' : 'Could not save the QR image. Please retry.',
                )
              }
            >
              {zh ? '保存二维码' : 'Save QR image'}
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="set-runtime-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="set-field-desc" role="status">
          {notice}
        </p>
      )}
      <h4 className="set-pane-subtitle">{zh ? '已授权手机' : 'Authorized phones'}</h4>
      {status && status.devices.length === 0 && (
        <p className="set-field-desc">{zh ? '尚未配对手机。' : 'No phones paired yet.'}</p>
      )}
      {status?.devices.map((device) => (
        <div key={device.id} className="set-field">
          <div className="set-field-stack set-remote-device">
            <span>{device.name}</span>
            <span className="set-field-desc">
              {device.revoked
                ? zh
                  ? '已撤销'
                  : 'Revoked'
                : `${zh ? '最近连接：' : 'Last seen: '}${new Date(device.lastSeen).toLocaleString(lang)}`}
            </span>
          </div>
          <button
            className="set-btn"
            disabled={device.revoked || !!busy || loading}
            aria-busy={busy === device.id}
            onClick={() => {
              if (
                lock.current ||
                !window.confirm(
                  zh
                    ? '撤销这台手机的连接授权？已接收的任务可在本机任务中停止。'
                    : 'Revoke this phone? Accepted tasks can be stopped in the local task list.',
                )
              )
                return
              void run(
                device.id,
                async () => {
                  await window.aiOfficeRemote.revoke(device.id)
                  await refresh()
                  if (alive.current)
                    setNotice(zh ? '已撤销手机授权。' : 'Phone authorization revoked.')
                },
                zh ? '撤销未完成，请重试。' : 'Revocation failed. Please retry.',
              )
            }}
          >
            {busy === device.id ? copy.working : zh ? '撤销' : 'Revoke'}
          </button>
        </div>
      ))}
    </section>
  )
}
