import type { OutcomeMemoryEntry } from '@genoffice/project-store'

export function OutcomeMemoryList({
  entries,
  lang,
}: {
  entries: OutcomeMemoryEntry[]
  lang: string
}) {
  const zh = /^zh/i.test(lang)
  const t = (cn: string, en: string) => (zh ? cn : en)
  if (!entries.length) return null
  return (
    <section className="outcome-memory" aria-label={t('成果记忆', 'Outcome memory')}>
      <strong>{t('记住的成果', 'Remembered outcomes')}</strong>
      <small>
        {t(
          '以下记录对应当时的核验结果。继续修改前，大狗会检查当前文件。',
          'These records describe past observations. BigDog must inspect current files before editing.',
        )}
      </small>
      {entries.slice(0, 8).map((entry) => (
        <article key={entry.id}>
          <strong>{entry.file.name}</strong>
          <small>
            {entry.origin === 'imported'
              ? t('迁入历史 · 本机未核验原操作', 'Imported history · operation not verified here')
              : t('已核验的历史成果', 'Host-verified historical outcome')}
            {' · '}
            {entry.status === 'reverted'
              ? t('已撤销', 'Reverted')
              : entry.status === 'uncertain'
                ? t('状态待核对', 'Needs review')
                : entry.file.saveState === 'saved'
                  ? t('当时已保存', 'Saved at that time')
                  : entry.file.saveState === 'unknown'
                    ? t('保存状态未确认', 'Save state unknown')
                    : t('当时未保存到文件', 'Not saved at that time')}
          </small>
          {entry.status === 'observed' && entry.resultOutcome !== 'completed' && (
            <small>
              {t(
                '这里只记录已核验的改动，不代表整个任务完成。',
                'Only verified changes are recorded here; this does not establish completion of the whole task.',
              )}
            </small>
          )}
          {entry.status !== 'observed' && (
            <p>
              {entry.status === 'reverted'
                ? t(
                    '这项修改已撤销，不作为当前已生效的修改。',
                    'This change was reverted; it is not a current applied result.',
                  )
                : t(
                    '撤销结果未完全确认，需要重新读取文件。',
                    'Undo was not fully verified. Read the file again.',
                  )}
            </p>
          )}
          {entry.changes
            .filter((change) => change.location.kind !== 'resource')
            .slice(0, 3)
            .map((change) => (
              <div className="outcome-memory-change" key={change.id}>
                <small>
                  {change.location.sheet ?? ''}{' '}
                  {change.location.range ??
                    change.location.name ??
                    (change.location.page !== undefined
                      ? t('页 ', 'Page ') + change.location.page
                      : change.location.slide !== undefined
                        ? t('幻灯片 ', 'Slide ') + change.location.slide
                        : change.location.line !== undefined
                          ? t('行 ', 'Line ') + change.location.line
                          : change.location.index !== undefined
                            ? t('文档块 ', 'Block ') + change.location.index
                            : '')}
                </small>
                <p>
                  {change.before || t('空', 'Empty')} → {change.after || t('空', 'Empty')}
                </p>
              </div>
            ))}
          {entry.changes.some((change) => change.location.kind === 'resource') && (
            <details>
              <summary>
                {t('资源变化', 'Resource changes')} (
                {entry.changes.filter((change) => change.location.kind === 'resource').length})
              </summary>
              {entry.changes
                .filter((change) => change.location.kind === 'resource')
                .map((change) => (
                  <small key={change.id}>
                    {change.location.name}
                    {' · '}
                    {change.before === undefined
                      ? t('新增', 'Added')
                      : change.after === undefined
                        ? t('删除', 'Removed')
                        : t('已变更', 'Changed')}
                  </small>
                ))}
            </details>
          )}
          {(entry.incomplete || entry.omitted > 0 || entry.changes.length > 3) && (
            <small>
              {t(
                '这里只展示部分改动，完整细节保留在成果记录中。',
                'An excerpt is shown here. Full details remain in the result record.',
              )}
            </small>
          )}
          <details>
            <summary>{t('核验来源', 'Evidence source')}</summary>
            <small>
              {t('记录时间：', 'Recorded: ')}
              {new Date(entry.recordedAt).toLocaleString()}
            </small>
            <small>
              {t('成果记录：', 'Result: ')}
              {entry.recordId}
            </small>
            <small>
              {t('证据：', 'Evidence: ')}
              {entry.evidenceId}
            </small>
            {entry.taskId && (
              <small>
                {t('任务：', 'Task: ')}
                {entry.taskId}
              </small>
            )}
            {entry.file.diskVersion && (
              <small>
                {t('文件版本：', 'File version: ')}
                {entry.file.diskVersion}
              </small>
            )}
          </details>
        </article>
      ))}
      {entries.length > 8 && (
        <small>
          {t(
            '其余成果会按当前问题检索，也可在成果历史中查看。',
            'Other outcomes are retrieved when relevant and remain in result history.',
          )}
        </small>
      )}
    </section>
  )
}
