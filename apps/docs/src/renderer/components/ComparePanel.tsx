import { Fragment } from 'react'
import type { CompareEntry } from '../editor/compare'
import type { WordRoundReview } from '../../shared/agent-round-review'
import { summarize } from '../editor/compare'
import { useI18n } from '../i18n/locale'
import { IconCompare } from './icons'

/**
 * Review → Compare result pane: paragraph-level differences between the open
 * document and a chosen second file. Unchanged stretches collapse to a count.
 */
export function ComparePanel({
  otherName,
  entries,
  round,
  onClose,
}: {
  otherName: string
  entries: CompareEntry[]
  round?: WordRoundReview
  onClose: () => void
}) {
  const { t, lang } = useI18n()
  const zh = lang.startsWith('zh')
  const version = [round?.baseVersion?.slice(0, 12), round?.resultVersion?.slice(0, 12)]
  const { added, removed, changed } = summarize(entries)
  const rows: Array<{ key: number; entry?: CompareEntry; sameCount?: number }> = []
  let sameRun = 0
  entries.forEach((entry, i) => {
    if (entry.kind === 'same') {
      sameRun++
      return
    }
    if (sameRun > 0) {
      rows.push({ key: rows.length, sameCount: sameRun })
      sameRun = 0
    }
    rows.push({ key: rows.length, entry })
    void i
  })
  if (sameRun > 0) rows.push({ key: rows.length, sameCount: sameRun })

  return (
    <aside className="comments-pane compare-pane">
      <div className="comments-pane-head">
        <span className="comments-pane-title">
          <IconCompare size={14} />{' '}
          {round ? (zh ? '本轮修订' : 'Round revisions') : t('appCompareResult')}
        </span>
        <button
          className="comments-pane-close"
          data-tip={t('appClose')}
          aria-label={t('appClose')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="compare-meta">
        {round ? (
          <div>
            <div>{new Date(round.completedAt).toLocaleString()}</div>
            {version.every(Boolean) && (
              <div title={round.baseVersion + ' → ' + round.resultVersion}>
                {zh ? '基线' : 'Base'} <code>{version[0]}</code> → {zh ? '结果' : 'Result'}{' '}
                <code>{version[1]}</code>
              </div>
            )}
            {round.state === 'undone' && <div>{zh ? '本轮已回退' : 'Round reverted'}</div>}
            {round.state === 'undo-failed' && (
              <div>{zh ? '回退需要核对' : 'Rollback needs review'}</div>
            )}
            {round.incomplete && (
              <div>{zh ? '显示已记录的差异摘录' : 'Showing recorded excerpts'}</div>
            )}
          </div>
        ) : (
          <>
            {t('appCompareWithPrefix')}
            <b>{otherName}</b>
          </>
        )}
        <div>{t('appCompareStats', { added, removed, changed })}</div>
        {!!round?.fileChangeCount && (
          <div>
            {zh
              ? '另有 ' + round.fileChangeCount + ' 项文件级变化，可在成果详情中查看。'
              : 'See the result details for ' + round.fileChangeCount + ' file-level changes.'}
          </div>
        )}
      </div>
      <div className="comments-pane-list">
        {added + removed + changed === 0 &&
          (round ? (
            <div className="comments-empty">
              {zh
                ? '这轮没有可显示的定位差异。'
                : 'No located changes were recorded for this round.'}
            </div>
          ) : (
            <div className="comments-empty">{t('appCompareIdentical')}</div>
          ))}
        {rows.map((row) => (
          <Fragment key={row.key}>
            {row.sameCount !== undefined && (
              <div className="compare-same">{t('appCompareSameRun', { n: row.sameCount })}</div>
            )}
            {row.entry && (
              <div className={`compare-card compare-${row.entry.kind}`}>
                {row.entry.location && <small>{row.entry.location}</small>}
                {row.entry.kind !== 'added' && (
                  <div className="compare-left">{row.entry.left || t('appEmptyParagraph')}</div>
                )}
                {row.entry.kind !== 'removed' && (
                  <div className="compare-right">{row.entry.right || t('appEmptyParagraph')}</div>
                )}
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </aside>
  )
}
