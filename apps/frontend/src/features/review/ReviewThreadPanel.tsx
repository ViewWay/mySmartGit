// ReviewThreadPanel：载体无关的评论区 UI（Diff / 树预览共用）。
// 线程列表 + 回复输入 + 已解决开关 + 删除；新建走 compose 框。
import { useId, useState, type FormEvent } from 'react'
import { CheckCircle2, Circle, MessageSquare, Send, Trash2, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { ReviewThread } from '@branchline/git-models'

export type ReviewThreadPanelProps = {
  /** 当前锚点（行）上的线程，调用方已按文件/ref 过滤并排序。 */
  threads: ReviewThread[]
  /** 无线程时显示的新建锚点行号；null 表示纯浏览模式。 */
  composeLine: number | null
  /** 范围评论的起止行（end>start 时头部/占位显示范围）；单行传 null。 */
  composeRange?: { start: number; end: number } | null
  busy?: boolean
  error?: string | null
  onCreate: (body: string) => void
  onReply: (threadId: string, body: string) => void
  onResolve: (threadId: string, resolved: boolean) => void
  onDelete: (threadId: string) => void
  onClose: () => void
}

/** 单行输入框：Enter 发送。 */
function ReviewComposer({
  placeholder,
  busy,
  submitLabel,
  onSubmit,
}: {
  placeholder: string
  busy: boolean
  submitLabel: string
  onSubmit: (body: string) => void
}) {
  const [body, setBody] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = body.trim()
    if (!trimmed || busy) return
    onSubmit(trimmed)
    setBody('')
  }
  return <form className="review-composer" onSubmit={submit}>
    <input
      value={body}
      onChange={(event) => setBody(event.target.value)}
      placeholder={placeholder}
      disabled={busy}
    />
    <button type="submit" disabled={busy || !body.trim()} title={submitLabel} aria-label={submitLabel}>
      <Send size={13}/>
    </button>
  </form>
}

export function ReviewThreadPanel({
  threads,
  composeLine,
  composeRange,
  busy,
  error,
  onCreate,
  onReply,
  onResolve,
  onDelete,
  onClose,
}: ReviewThreadPanelProps) {
  const { t } = useI18n()
  const headingId = useId()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const isRange = composeRange != null && composeRange.end > composeRange.start
  const count = threads.reduce((sum, thread) => sum + thread.comments.length, 0)
  return <section className="review-thread-panel" aria-labelledby={headingId}>
    <div className="review-panel-header">
      <MessageSquare size={13}/>
      <span id={headingId}>
        {composeLine == null
          ? t('review.panelTitle')
          : isRange
            ? t('review.panelTitleAtRange', { start: composeRange!.start, end: composeRange!.end })
            : t('review.panelTitleAtLine', { line: composeLine })}
      </span>
      {count > 0 && <span className="review-count">{count}</span>}
      <span className="review-spacer"/>
      {error && <span className="review-panel-error" role="alert">{error}</span>}
      <button type="button" className="review-icon-button" onClick={onClose} aria-label={t('review.close')}>
        <X size={13}/>
      </button>
    </div>
    <div className="review-panel-body">
      {threads.map((thread) => <div key={thread.id} className={`review-thread ${thread.resolved ? 'resolved' : ''}`}>
        {thread.comments.map((comment, index) => <div key={comment.id} className="review-comment">
          <div className="review-comment-meta">
            <span className="review-author">{comment.author || t('review.anonymous')}</span>
            {index === 0 && <span className="review-line-badge">{thread.endLine != null && thread.endLine > thread.line ? t('review.rangeBadge', { start: thread.line, end: thread.endLine }) : t('review.lineBadge', { line: thread.line })}</span>}
            {thread.remote && <span className="review-remote-badge" title={t('review.remoteHint')}>{t('review.remotePublished')}</span>}
          </div>
          <p className="review-comment-body">{comment.body}</p>
        </div>)}
        <div className="review-thread-actions">
          <ReviewComposer
            placeholder={t('review.replyPlaceholder')}
            busy={Boolean(busy)}
            submitLabel={t('review.reply')}
            onSubmit={(body) => onReply(thread.id, body)}
          />
          <button
            type="button"
            className="review-icon-button"
            onClick={() => onResolve(thread.id, !thread.resolved)}
            title={thread.resolved ? t('review.markUnresolved') : t('review.markResolved')}
            aria-label={thread.resolved ? t('review.markUnresolved') : t('review.markResolved')}
          >
            {thread.resolved ? <CheckCircle2 size={14}/> : <Circle size={14}/>}
          </button>
          {confirmDeleteId === thread.id
            ? <button type="button" className="review-danger-button" onClick={() => { setConfirmDeleteId(null); onDelete(thread.id) }}>
              {t('review.confirmDelete')}
            </button>
            : <button
              type="button"
              className="review-icon-button"
              onClick={() => setConfirmDeleteId(thread.id)}
              title={thread.remote ? t('review.deleteRemoteHint') : t('review.delete')}
              aria-label={t('review.delete')}
            >
              <Trash2 size={14}/>
            </button>}
        </div>
      </div>)}
      {composeLine != null && threads.length === 0 && <ReviewComposer
        placeholder={isRange ? t('review.composeRangePlaceholder', { start: composeRange!.start, end: composeRange!.end }) : t('review.composePlaceholder', { line: composeLine })}
        busy={Boolean(busy)}
        submitLabel={t('review.create')}
        onSubmit={onCreate}
      />}
      {threads.length === 0 && composeLine == null && <p className="review-empty-hint">{t('review.emptyHint')}</p>}
    </div>
  </section>
}
