import { useEffect, useRef, useState } from 'react'

type Mode = 'auto' | 'per-action'

/** The same persisted policy as WorkspaceChat, exposed beside each composer. */
export function EditorApprovalControl({ zh }: { zh: boolean }) {
  const [mode, setMode] = useState<Mode>('per-action')
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const busy = useRef(false)
  const mounted = useRef(false)
  const revision = useRef(0)
  const unavailable = zh
    ? '无法读取审批设置，修改操作不会自动执行。'
    : 'Approval settings unavailable; changes will not run automatically.'

  useEffect(() => {
    mounted.current = true
    let alive = true
    let unsubscribe = () => {}
    setReady(false)
    setError('')
    const bridge = window.editorApproval
    if (!bridge?.setMode) {
      setError(unavailable)
    } else {
      try {
        unsubscribe = bridge.onModeChanged((next) => {
          if (!alive || (next !== 'auto' && next !== 'per-action')) return
          revision.current++
          setMode(next)
          setReady(true)
          setError('')
        })
        const version = revision.current
        void bridge
          .getMode()
          .then((next) => {
            if (!alive || version !== revision.current) return
            if (next !== 'auto' && next !== 'per-action') throw new Error(unavailable)
            setMode(next)
            setReady(true)
          })
          .catch(() => {
            if (alive && version === revision.current) setError(unavailable)
          })
      } catch {
        setError(unavailable)
      }
    }
    return () => {
      alive = false
      mounted.current = false
      unsubscribe()
    }
  }, [attempt, unavailable])

  const apply = async (next: Mode) => {
    if (busy.current || !ready || next === mode || !window.editorApproval?.setMode) return
    busy.current = true
    const version = revision.current
    try {
      setSaving(true)
      setError('')
      const actual = await window.editorApproval.setMode(next)
      if (actual !== 'auto' && actual !== 'per-action') throw new Error(unavailable)
      if (mounted.current) {
        // Broadcasts are ordered by main; a late invoke result must not undo
        // another panel's more recent policy change.
        if (version === revision.current) setMode(actual)
      }
    } catch {
      if (mounted.current)
        setError(
          zh ? '审批方式保存失败，请重试。' : 'Could not save the approval mode. Try again.',
        )
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <div className="editor-approval-control" aria-busy={saving}>
      <div className="editor-approval-mode-row">
        <span>{zh ? '工具执行' : 'Tool execution'}</span>
        <div
          className="editor-approval-modes"
          role="group"
          aria-label={zh ? '工具批准方式' : 'Tool approval mode'}
        >
          <button
            type="button"
            disabled={!ready || saving}
            aria-pressed={ready && mode === 'per-action'}
            onClick={() => void apply('per-action')}
          >
            {zh ? '每次审批' : 'Ask each time'}
          </button>
          <button
            type="button"
            disabled={!ready || saving}
            aria-pressed={ready && mode === 'auto'}
            onClick={() => void apply('auto')}
          >
            {zh ? '自动执行' : 'Auto execute'}
          </button>
        </div>
      </div>
      {error && (
        <div role="alert" className="editor-approval-error">
          {error}{' '}
          {!ready && (
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              {zh ? '重试' : 'Retry'}
            </button>
          )}
        </div>
      )}
      <span className="editor-approval-sr" role="status">
        {saving
          ? zh
            ? '正在保存'
            : 'Saving'
          : ready
            ? mode === 'auto'
              ? zh
                ? '已启用自动执行'
                : 'Auto execution enabled'
              : zh
                ? '已启用每次审批'
                : 'Per-action approval enabled'
            : ''}
      </span>
    </div>
  )
}
