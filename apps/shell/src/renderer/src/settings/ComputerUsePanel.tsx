import { useEffect, useRef, useState } from 'react'
import type { ComputerUseStatus } from '../../../shared/computer-use-api'
import { useI18n } from '../locale'

export function ComputerUsePanel() {
  const { lang } = useI18n(),
    zh = lang.startsWith('zh')
  const [status, setStatus] = useState<ComputerUseStatus>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(false)
  const mounted = useRef(true),
    lock = useRef(false)
  const run = async (action: 'status' | 'restart' | 'stop') => {
    if (lock.current) return
    lock.current = true
    setBusy(action)
    setError(false)
    try {
      const api = window.aiOfficeComputer
      if (!api) throw new Error('computer_bridge_missing')
      if (action === 'stop') {
        await api.stop()
        if (mounted.current)
          setStatus(
            (previous) => previous && { ...previous, state: 'stopped', active: false, waiting: 0 },
          )
      } else {
        const value = await api[action]()
        if (mounted.current) setStatus(value)
      }
    } catch {
      if (mounted.current) setError(true)
    } finally {
      lock.current = false
      if (mounted.current) setBusy('')
    }
  }
  useEffect(() => {
    mounted.current = true
    void run('status')
    return () => {
      mounted.current = false
    }
  }, [])
  return (
    <section className="set-computer-panel" aria-label={zh ? '电脑操作' : 'Computer controls'}>
      <h4>{zh ? '电脑操作' : 'Computer controls'}</h4>
      <p className="set-field-desc">
        {zh
          ? '让大狗操作其他应用，沿用当前审批方式。视觉模型可使用窗口截图；重启后会重新观察。'
          : 'Let BigDog operate other apps under the current approval mode. Visual models can use window screenshots; resumed tasks observe again.'}
      </p>
      <p className="set-field-desc" role="status">
        {busy
          ? zh
            ? '正在处理…'
            : 'Working…'
          : status?.state === 'stopped'
            ? zh
              ? '电脑操作已停止'
              : 'Computer actions stopped'
            : status?.active
              ? zh
                ? '正在使用电脑'
                : 'Computer in use'
              : status?.available
                ? zh
                  ? '电脑操作组件已就绪'
                  : 'Computer controls ready'
                : zh
                  ? '电脑操作组件不可用'
                  : 'Computer controls unavailable'}
        {!!status?.waiting &&
          (zh ? ` · ${status.waiting} 个任务等待中` : ` · ${status.waiting} tasks waiting`)}
      </p>
      <div className="set-about-actions">
        <button
          className="set-btn"
          disabled={!!busy}
          aria-busy={busy === 'status'}
          onClick={() => void run('status')}
        >
          {zh ? '检查' : 'Check'}
        </button>
        <button
          className="set-btn"
          disabled={!!busy || status?.active}
          aria-busy={busy === 'restart'}
          onClick={() => void run('restart')}
        >
          {zh ? '重新连接组件' : 'Reconnect component'}
        </button>
        <button
          className="set-btn"
          disabled={!!busy}
          aria-busy={busy === 'stop'}
          onClick={() => void run('stop')}
        >
          {zh ? '停止电脑操作' : 'Stop computer actions'}
        </button>
      </div>
      {error && (
        <p className="set-runtime-error" role="alert">
          {zh ? '操作未完成，请重试。' : 'Could not complete the operation. Please retry.'}
        </p>
      )}
      {!busy && status && !status.available && (
        <p className="set-field-desc">
          {zh
            ? '请先重新连接组件；仍不可用时，检查安装包是否完整。'
            : 'Reconnect the component first. If it remains unavailable, check the app installation.'}
        </p>
      )}
    </section>
  )
}
