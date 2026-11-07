import { useI18n } from '../../i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Cloud, Plus, RefreshCw, Tag } from 'lucide-react'
import {
  createRepositoryAnnotatedTag,
  createRepositorySignedTag,
  deleteRepositoryRemoteTag,
  deleteRepositoryTag,
  loadRepositoryRemotes,
  loadRepositoryTagDetails,
  pushRepositoryTags,
  type RemoteOperationReport,
  type RepositoryRemoteDetail,
  type RepositorySnapshot,
  type RepositoryTagDetail,
} from '../../repository'
import { Button } from '../../components/Button'
import { CompactSelect } from '../../components/CompactSelect'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import { CreateTagDialog, type CreateTagPayload } from './CreateTagDialog'
import { credentialNotice, filterTags, tagKindLabel, tagRiskText } from './remotePanelState'
import { useReportedAction } from './useReportedAction'

/**
 * 标签管理：标签明细（类型 / 打标签人 / 日期 / 签名 / 指向提交）+ 创建注释或签名标签、
 * 推送到指定远程、删除本地与远端标签。
 *
 * 破坏性动作一律先取后端预览：`executed=false` 时仓库没有被改动，
 * 由确认框展示 warnings / affected，用户确认后才带 `confirm=true` 再调用一次。
 */
export function TagManagementPanel({ repository, query, onOpenTag, onSnapshot, onNotice }: {
  repository: RepositorySnapshot
  query: string
  onOpenTag: (tag: string) => void
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}) {
  const { t } = useI18n()
  const [tags, setTags] = useState<RepositoryTagDetail[]>([])
  const [remotes, setRemotes] = useState<RepositoryRemoteDetail[]>([])
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const { confirm, confirmDialog } = useConfirmDialog()
  const run = useReportedAction({ confirm, onSnapshot, onNotice })
  const remoteNames = useMemo(() => remotes.map((remote) => remote.name), [remotes])
  const defaultRemote = remoteNames.includes('origin') ? 'origin' : remoteNames[0] ?? ''

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [details, remoteList] = await Promise.all([
        loadRepositoryTagDetails(repository.path),
        // 远程列表只是可选上下文：读不到时标签本地操作仍然可用。
        loadRepositoryRemotes(repository.path).catch(() => [] as RepositoryRemoteDetail[]),
      ])
      setTags(details)
      setRemotes(remoteList)
      const notice = remoteList.map((remote) => credentialNotice(remote, t)).find(Boolean)
      if (notice) onNotice(notice)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [onNotice, repository.path])

  useEffect(() => { void refresh() }, [refresh])

  const applyReport = (report: RemoteOperationReport | null) => {
    if (!report) return
    setTags(report.tags)
    setRemotes(report.remotes)
  }

  const create = async (payload: CreateTagPayload) => {
    setBusy('create-tag')
    const report = await run(
      (confirmFlag) => (payload.signed
        ? createRepositorySignedTag(repository.path, payload.tag, payload.commit, payload.message, payload.signingKey ?? null, payload.force, confirmFlag)
        : createRepositoryAnnotatedTag(repository.path, payload.tag, payload.commit, payload.message, payload.force, confirmFlag)),
      t('repository.tag.create'),
      t('tag.created', { tag: payload.tag }),
    )
    applyReport(report)
    setBusy(null)
    if (report?.executed) setCreateOpen(false)
  }

  const push = async (tag: string) => {
    const remote = targets[tag] ?? defaultRemote
    if (!remote) {
      onNotice(t('repository.tag.noRemoteForCreate'))
      return
    }
    setBusy(`push:${tag}`)
    // push_repository_tags 唯一的预览场景就是「远端同名标签指向不同对象」，
    // 因此用户确认等价于同意强推：第二轮同时带上 force 与 confirm。
    const report = await run(
      (confirmFlag) => pushRepositoryTags(repository.path, remote, [tag], confirmFlag, confirmFlag),
      t('tag.pushToRemote', { remote }),
      t('tag.pushed', { tag, remote }),
    )
    applyReport(report)
    setBusy(null)
  }

  const removeLocal = async (tag: string) => {
    setBusy(`delete:${tag}`)
    applyReport(await run(
      (confirmFlag) => deleteRepositoryTag(repository.path, tag, confirmFlag),
      t('repository.tag.deleteLocalTitle'),
      t('tag.localDeleted', { tag }),
    ))
    setBusy(null)
  }

  const removeRemote = async (tag: string) => {
    const remote = targets[tag] ?? defaultRemote
    if (!remote) {
      onNotice(t('repository.tag.noRemoteForDelete'))
      return
    }
    setBusy(`delete-remote:${tag}`)
    applyReport(await run(
      (confirmFlag) => deleteRepositoryRemoteTag(repository.path, remote, tag, confirmFlag),
      t('tag.deleteRemoteTitle', { remote }),
      t('tag.deletedFromRemote', { remote, tag }),
    ))
    setBusy(null)
  }

  const visible = filterTags(tags, query)

  return <section className="structure-panel workspace-page">
    <div className="workspace-page-heading">
      <div><span className="eyebrow">{t('repository.tree.title')}</span><h2>{t('nav.tags')}</h2><p>{t('tag.listSummary', { count: tags.length })}</p></div>
      <div className="structure-actions">
        <Button variant="secondary" disabled={loading || busy !== null} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? t('repository.tag.refreshing') : t('repository.tag.refresh')}</Button>
        <Button variant="primary" className="structure-heading-action" onClick={() => setCreateOpen(true)}><Plus size={14}/>{t('repository.tag.create')}</Button>
      </div>
    </div>
    <div className="structure-list">
      {visible.map((tag) => {
        const risk = tagRiskText(tag, t)
        const remote = targets[tag.name] ?? defaultRemote
        return <div key={tag.name}>
          <button className="tag-row" onClick={() => onOpenTag(tag.name)} title={t('tag.locatedCommit', { name: tag.name })}>
            <span className="structure-icon"><Tag size={15}/></span>
            <span>
              <strong>{tag.name}</strong>
              <small>{t('tag.listLine', { kind: tagKindLabel(tag.kind, t), signed: tag.signed ? t('repository.tag.signed') : '', target: tag.target || '—', date: tag.date || t('repository.tag.noDate'), tagger: tag.tagger ? ` · ${tag.tagger}` : '' })}</small>
              <code>{tag.subject || t('repository.tag.noMessage')}</code>
            </span>
            {tag.onBranch ? <i>{t('repository.tag.onBranch')}</i> : <i className="warn">{t('repository.tag.notOnBranch')}</i>}
            <ChevronRight size={15}/>
          </button>
          <div className="structure-actions tag-row-actions">
            {risk && <span className="tag-row-risk">{risk}</span>}
            {remoteNames.length > 0 && <CompactSelect className="tag-remote-select" value={remote} options={remoteNames.map((name) => ({ value: name, label: name }))} onChange={(value) => setTargets((current) => ({ ...current, [tag.name]: value }))} ariaLabel={t('repository.tag.pickRemote')}/>}
            <Button variant="secondary" disabled={busy !== null || !remoteNames.length} onClick={() => void push(tag.name)}><Cloud size={13}/>{busy === `push:${tag.name}` ? t('repository.tag.pushing') : t('repository.tag.push')}</Button>
            <Button variant="danger" disabled={busy !== null || !remoteNames.length} onClick={() => void removeRemote(tag.name)}>{t('repository.tag.deleteRemoteShort')}</Button>
            <Button variant="danger" disabled={busy !== null} onClick={() => void removeLocal(tag.name)}>{t('repository.tag.deleteLocalShort')}</Button>
          </div>
        </div>
      })}
      {tags.length === 0 && !loading && <div className="workspace-hint"><Tag size={26}/><strong>{t('repository.tag.none')}</strong><span>{t('repository.tag.emptyHint')}</span></div>}
      {tags.length > 0 && visible.length === 0 && <div className="workspace-hint"><Tag size={26}/><strong>{t('repository.tag.noSearchMatch')}</strong><span>{t('repository.tag.noSearchMatchHint')}</span></div>}
      {!remoteNames.length && tags.length > 0 && <div className="workspace-hint"><Cloud size={24}/><strong>{t('repository.tag.noRemote')}</strong><span>{t('repository.tag.remoteRequiredHint')}</span></div>}
    </div>
    {createOpen && <CreateTagDialog existingTags={tags.map((tag) => tag.name)} defaultCommit={repository.branch || 'HEAD'} busy={busy === 'create-tag'} onClose={() => setCreateOpen(false)} onSubmit={create}/>}
    {confirmDialog}
  </section>
}
