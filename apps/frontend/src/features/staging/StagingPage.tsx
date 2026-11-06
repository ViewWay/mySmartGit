import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Archive, ArrowDown, Check, ChevronDown, Copy, FileCode2, FileText, GitCommitHorizontal, History, Minus, Pencil, Plus, RefreshCw, Rows3, Trash2 } from 'lucide-react'
import { ContextMenu } from '../../components/ContextMenu'
import { Button } from '../../components/Button'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import {
  commitRepository,
  createScopedRepositoryStash,
  discardRepositoryFiles,
  loadRepository,
  loadRepositoryUnstagedFileDiff,
  loadRepositoryStagedFileDiff,
  restoreRepositoryPatch,
  clearRepositoryCommitTemplate,
  stageRepositoryFiles,
  stageRepositoryPatch,
  updateRepositoryCommitTemplate,
  unstageRepositoryFiles,
  unstageRepositoryPatch,
  type RepositoryFile,
  type RepositorySnapshot,
} from '../../repository'
import { DiffPanel } from '../diff/DiffPanel'
import { CommitMessageAssistant } from '../ai/CommitMessageAssistant'
import { useResizablePane } from '../../components/useResizablePane'
import { commitButtonState, draftAfterAction, initialCommitMessage, templateMessage } from './commitMessage'
import { useI18n } from '../../i18n'
import { isBooleanRecord, usePersistentState } from '../../persistentState'
import { stageSelectionKey, type StageSelection } from './stagingSelection'

type StagingPageProps = {
  repository: RepositorySnapshot | null
  undoCommitMessage?: string | null
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
  onOperationChange?: (label: string | null) => void
  onOpenHistory: (path: string, tab: 'history' | 'blame') => void
  onOpenLineHistory: (path: string, line: number) => void
  onOpenConflict?: (path: string) => void
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

function fileDirectory(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator >= 0 ? path.slice(0, separator + 1) : ''
}

function StageFilePath({ path }: { path: string }) {
  const directory = fileDirectory(path)
  return <span className={`stage-file-path${directory ? ' has-directory' : ''}`} title={path}>
    <span className="stage-file-name">{fileName(path)}</span>
    {directory && <span className="stage-file-directory">{directory}</span>}
  </span>
}

const fileStatusKeys: Record<string, { label: string; className: string; description: string }> = {
  A: { label: 'stage.status.add', className: 'added', description: 'stage.status.addDescription' },
  M: { label: 'stage.status.modified', className: 'modified', description: 'stage.status.modifiedDescription' },
  D: { label: 'stage.status.deleted', className: 'deleted', description: 'stage.status.deletedDescription' },
  R: { label: 'stage.status.renamed', className: 'renamed', description: 'stage.status.renamedDescription' },
  C: { label: 'stage.status.copied', className: 'copied', description: 'stage.status.copiedDescription' },
  U: { label: 'stage.status.conflict', className: 'conflicted', description: 'stage.status.conflictDescription' },
}
const UNMERGED_FILE_TYPES = new Set(['U', 'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function getFileStatus(type: string, t: (key: string) => string) {
  const code = type.trim().charAt(0).toUpperCase()
  const meta = fileStatusKeys[code]
  return meta
    ? { label: t(meta.label), className: meta.className, description: t(meta.description) }
    : { label: type || t('stage.status.fallback'), className: 'modified', description: t('stage.status.fallbackDescription') }
}

export function StagingPage({ repository, undoCommitMessage, onSnapshot, onNotice, onOperationChange, onOpenHistory, onOpenLineHistory, onOpenConflict }: StagingPageProps) {
  const { t } = useI18n()
  const [fullMessage, setFullMessage] = useState('')
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false)
  const [templateDraft, setTemplateDraft] = useState('')
  const [amend, setAmend] = useState(false)
  const [sign, setSign] = useState(false)
  const [busy, setBusy] = useState(false)
  const patchBusy = useRef(false)
  const [selectedFile, setSelectedFile] = useState<StageSelection | null>(null)
  const [diffRevision, setDiffRevision] = useState(0)
  const [sectionOpen, setSectionOpen] = usePersistentState('branchline.stagingSectionsOpen.v1', { staged: true, unstaged: true }, isBooleanRecord)
  const [contextFile, setContextFile] = useState<{ file: RepositoryFile; scope: 'staged' | 'unstaged'; x: number; y: number } | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const [widePreview, setWidePreview] = useState(false)
  const stagingWidth = useResizablePane('branchline.stagingWidth.v1', 430, 300, 720, 'horizontal')
  const filesHeight = useResizablePane('branchline.stagingFilesHeight.v1', 360, 150, 720, 'vertical')
  const appliedTemplateKey = useRef<string | null>(null)
  const files = repository?.files ?? []
  const conflictFilePaths = useMemo(() => {
    const paths = new Set(repository?.operation?.conflicts ?? [])
    files.forEach((file) => {
      const type = file.type.trim().toUpperCase()
      if (UNMERGED_FILE_TYPES.has(type)) paths.add(file.path)
    })
    return paths
  }, [files, repository?.operation?.conflicts])
  const conflictFiles = useMemo(() => files.filter((file) => conflictFilePaths.has(file.path)), [conflictFilePaths, files])
  const stagedFiles = useMemo(() => files.filter((file) => file.staged && !conflictFilePaths.has(file.path)), [conflictFilePaths, files])
  const unstagedFiles = useMemo(() => files.filter((file) => !conflictFilePaths.has(file.path) && (file.unstaged || (!file.staged && !file.unstaged))), [conflictFilePaths, files])
  const diffFileEntries = useMemo(() => [
    ...stagedFiles.map((file) => ({ file, scope: 'staged' as const })),
    ...unstagedFiles.map((file) => ({ file, scope: 'unstaged' as const })),
  ], [stagedFiles, unstagedFiles])
  const selectedDiffEntry = useMemo(() => diffFileEntries.find((entry) => stageSelectionKey({ path: entry.file.path, scope: entry.scope }) === stageSelectionKey(selectedFile)) ?? null, [diffFileEntries, selectedFile])
  const loadStagingRows = useCallback((path: string, _index: number | undefined, showWhitespace: boolean) => selectedFile?.scope === 'unstaged'
    ? loadRepositoryUnstagedFileDiff(repository?.path ?? '', path, showWhitespace)
    : loadRepositoryStagedFileDiff(repository?.path ?? '', path, showWhitespace), [repository?.path, selectedFile?.scope])

  useEffect(() => {
    if (!selectedDiffEntry) setSelectedFile(diffFileEntries[0] ? { path: diffFileEntries[0].file.path, scope: diffFileEntries[0].scope } : null)
  }, [diffFileEntries, selectedDiffEntry])

  const applyConfiguredTemplate = () => {
    const content = repository?.commitTemplate?.content ?? ''
    setFullMessage(templateMessage(content))
  }

  useEffect(() => {
    const template = repository?.commitTemplate
    const mergeOperation = repository?.operation?.kind === 'merge' ? repository.operation : undefined
    const key = mergeOperation
      ? `${repository?.path ?? 'empty'}\u0000merge\u0000${mergeOperation.currentCommit ?? mergeOperation.message ?? ''}`
      : `${repository?.path ?? 'empty'}\u0000template\u0000${template?.path ?? ''}\u0000${template?.content ?? ''}`
    if (appliedTemplateKey.current === key) return
    appliedTemplateKey.current = key
    setFullMessage(initialCommitMessage(template?.content ?? '', mergeOperation))
    setTemplateDraft(template?.content ?? '')
  }, [repository?.commitTemplate?.content, repository?.commitTemplate?.path, repository?.operation?.currentCommit, repository?.operation?.kind, repository?.operation?.message, repository?.path])

  useEffect(() => {
    if (undoCommitMessage !== null && undoCommitMessage !== undefined) setFullMessage(undoCommitMessage)
  }, [undoCommitMessage])

  const run = async (action: () => Promise<RepositorySnapshot>, success: string, operationLabel?: string) => {
    setBusy(true)
    if (operationLabel) onOperationChange?.(operationLabel)
    let succeeded = false
    try {
      const snapshot = await action()
      onSnapshot(snapshot)
      onNotice(success)
      succeeded = true
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      if (operationLabel) onOperationChange?.(null)
      // 仅操作成功后重新套用模板；失败时保留用户草稿，避免刚写下的提交信息被模板冲掉。
      const content = repository?.commitTemplate?.content ?? ''
      setFullMessage((draft) => draftAfterAction({ succeeded, currentDraft: draft, templateContent: content }))
    }
  }
  const updateStaging = async (paths: string[], mode: 'stage' | 'unstage', force = false) => {
    if (!repository) return onNotice(t('stage.requiresRepository'))
    const pathSet = new Set(paths)
    const previousSnapshot = repository
    const optimisticFiles = files.map((file) => pathSet.has(file.path)
      ? { ...file, staged: mode === 'stage', unstaged: mode === 'unstage' }
      : file)
    setBusy(true)
    onSnapshot({ ...repository, files: optimisticFiles })
    try {
      const updatedFiles = mode === 'stage'
        ? await stageRepositoryFiles(repository.path, paths, force)
        : await unstageRepositoryFiles(repository.path, paths)
      if (mode === 'stage' && force) {
        try {
          const snapshot = await loadRepository(repository.path)
          onSnapshot(snapshot)
          onNotice(snapshot.operation?.conflicts.length
            ? `已强制暂存，仍有 ${snapshot.operation.conflicts.length} 个冲突文件待处理`
            : `已强制暂存 ${paths.length} 个冲突文件`)
        } catch {
          const remainingConflicts = repository.operation?.conflicts.filter((path) => !pathSet.has(path)) ?? []
          const operation = repository.operation?.kind === 'conflict' && remainingConflicts.length === 0
            ? undefined
            : repository.operation ? { ...repository.operation, conflicts: remainingConflicts } : undefined
          onSnapshot({ ...repository, files: updatedFiles, operation })
          onNotice(`已强制暂存 ${paths.length} 个冲突文件，仓库操作状态将在下次刷新时同步`)
        }
      } else {
        onSnapshot({ ...repository, files: updatedFiles })
        setDiffRevision((value) => value + 1)
        onNotice(t(mode === 'stage' ? 'stage.stagedCount' : 'stage.unstagedCount', { count: paths.length }))
      }
    } catch (error) {
      onSnapshot(previousSnapshot)
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const stage = (paths: string[], force = false) => updateStaging(paths, 'stage', force)
  const unstage = (paths: string[]) => updateStaging(paths, 'unstage')
  const applySelectedPatch = async (mode: 'stage' | 'restore' | 'unstage', patch: string, description: string) => {
    if (!repository || !patch || busy || patchBusy.current) return
    patchBusy.current = true
    setBusy(true)
    try {
      const action = mode === 'stage' ? stageRepositoryPatch : mode === 'restore' ? restoreRepositoryPatch : unstageRepositoryPatch
      const updatedFiles = await action(repository.path, patch)
      onSnapshot({ ...repository, files: updatedFiles })
      setDiffRevision((value) => value + 1)
      const verb = mode === 'stage' ? t('stage.verbStage') : mode === 'restore' ? t('stage.verbRestore') : t('stage.verbUnstage')
      onNotice(t('stage.patchDone', { verb, description }))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      patchBusy.current = false
      setBusy(false)
    }
  }
  const discard = async (paths: string[]) => {
    if (!repository) return onNotice(t('stage.requiresRepository'))
    if (!paths.length) return
    const confirmed = await confirm({ title: t('stage.discardWorkingChanges'), message: `确定丢弃选中的 ${paths.length} 个文件的未暂存改动？\n\n跟踪文件会恢复到当前暂存区版本，已暂存内容会保留；未跟踪文件会从磁盘永久删除。此操作无法撤销。`, confirmLabel: t('stage.discard'), variant: 'danger' })
    if (!confirmed) return
    setBusy(true)
    try {
      const updatedFiles = await discardRepositoryFiles(repository.path, paths)
      onSnapshot({ ...repository, files: updatedFiles })
      setDiffRevision((value) => value + 1)
      onNotice(`已丢弃 ${paths.length} 个文件的未暂存改动`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const quickStash = (scope: 'staged' | 'unstaged', count: number) => repository
    ? run(() => createScopedRepositoryStash(repository.path, scope, `快速 Stash：${scope === 'staged' ? t('stage.staged') : t('stage.unstaged')}变更`), `已将 ${count} 个${scope === 'staged' ? t('stage.staged') : t('stage.unstaged')}文件保存到 Stash`)
    : onNotice(t('stage.quickStashRequiresRepository'))
  const commit = () => {
    if (!repository) return onNotice(t('stage.requiresRepository'))
    const message = fullMessage
    if (!message.trim()) return onNotice(t('stage.commitMessageRequired'))
    return run(() => commitRepository(repository.path, message, amend, sign), t('stage.commitDone'), t('stage.committing'))
  }
  const saveRepositoryTemplate = async () => {
    if (!repository) return
    setBusy(true)
    try {
      const snapshot = await updateRepositoryCommitTemplate(repository.path, templateDraft)
      onSnapshot(snapshot)
      setTemplateEditorOpen(false)
      onNotice(t('stage.templateSaved'))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const restoreGlobalTemplate = async () => {
    if (!repository) return
    setBusy(true)
    try {
      const snapshot = await clearRepositoryCommitTemplate(repository.path)
      onSnapshot(snapshot)
      setTemplateEditorOpen(false)
      onNotice(t('stage.templateReset'))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const fileRow = (file: RepositoryFile, action: () => void, icon: 'add' | 'remove', scope: 'staged' | 'unstaged') => {
    const Icon = icon === 'add' ? Plus : Minus
    const FileIcon = file.path.includes('.') ? FileCode2 : FileText
    const status = getFileStatus(file.type, t)
    const selection = { path: file.path, scope }
    return <div className={`stage-file ${stageSelectionKey(selectedFile) === stageSelectionKey(selection) ? 'active' : ''}`} key={`${scope}-${file.path}`} onContextMenu={(event) => { event.preventDefault(); setSelectedFile(selection); setContextFile({ file, scope, x: event.clientX, y: event.clientY }) }}>
      <button className={`stage-file-open ${file.incoming ? 'has-incoming' : ''}`} onClick={() => { setSelectedFile(selection); setWidePreview(false) }} title={`点击查看 ${file.path} 的变更，右键查看更多操作`}><FileIcon size={15}/><span className={`stage-file-status ${status.className}`} title={status.description}>{status.label}</span><StageFilePath path={file.path}/>{file.incoming && <span className="stage-file-incoming" title={t('stage.remoteAlsoTouchedFile')}><ArrowDown size={13}/></span>}<span className="stage-file-stats"><small className="additions">+{file.add}</small><small className="deletions">-{file.del}</small></span></button>
      <div className="stage-file-actions">
        {scope === 'unstaged' && <Button variant="danger" className="stage-file-action" onClick={() => void discard([file.path])} disabled={busy} title={t('stage.discardUnstaged')}><Trash2 size={13}/></Button>}
        <button className="stage-file-action" onClick={action} disabled={busy} title={icon === 'add' ? t('stage.stageFiles') : t('stage.unstage')}><Icon size={13}/></button>
      </div>
    </div>
  }

  const forceStageConflict = async (file: RepositoryFile) => {
    if (!await confirm({ title: t('stage.forceStageConflicted'), message: `“${file.path}”仍处于冲突状态。\n\n强行暂存会将当前工作区内容写入暂存区，包括未处理的冲突标记。确定继续吗？`, confirmLabel: t('stage.forceStage'), variant: 'danger' })) return
    await stage([file.path], true)
  }

  const conflictRow = (file: RepositoryFile) => <div className="stage-file conflict-file" key={`conflict-${file.path}`}>
    <button className="stage-file-open" onClick={() => onOpenConflict?.(file.path)} title={`处理 ${file.path} 的冲突`}><FileCode2 size={15}/><span className="stage-file-status conflicted">{t('stage.status.conflict')}</span><StageFilePath path={file.path}/><span className="stage-file-stats"><small className="additions">+{file.add}</small><small className="deletions">-{file.del}</small></span></button>
    <div className="stage-file-actions"><button className="stage-file-action force-stage" onClick={() => forceStageConflict(file)} disabled={busy} title={t('stage.forceStageConflicted')} aria-label={t('stage.forceStageConflicted')}><Plus size={14}/></button></div>
  </div>

  const commitButton = commitButtonState({ stagedCount: stagedFiles.length, busy, amend }, t)

  const workspaceStyle = { '--staging-control-width': `${stagingWidth.value}px` } as CSSProperties
  const resizingClass = filesHeight.resizing ? 'pane-resizing-vertical' : stagingWidth.resizing ? 'pane-resizing' : ''
  return <section className={`workspace-page staging-page ${resizingClass}`}>
    <div className={`staging-workspace ${widePreview ? 'preview-wide' : ''}`} style={workspaceStyle}>
      <div className="staging-control-pane" style={{ gridTemplateRows: `${filesHeight.value}px 1px minmax(230px, 1fr)` }}>
        <div className="staging-file-sections">
          {conflictFiles.length > 0 && <div className="stage-section conflict-section">
            <div className="stage-section-header"><div className="stage-section-name"><span className="stage-section-marker"/><strong>{t('stage.status.conflict')}</strong><span className="stage-section-count">{conflictFiles.length}</span></div><span className="stage-section-hint">{t('stage.resolveThenStage')}</span></div>
            <div className="stage-section-files">{conflictFiles.map(conflictRow)}</div>
          </div>}
          <div className={`stage-section staged-section ${sectionOpen.staged ? '' : 'collapsed'}`}>
            <div className="stage-section-header"><button type="button" className="stage-section-toggle" onClick={() => setSectionOpen((value) => ({ ...value, staged: !value.staged }))} aria-expanded={sectionOpen.staged} title={sectionOpen.staged ? t('stage.collapseStaged') : t('stage.expandStaged')}><ChevronDown size={14}/></button><div className="stage-section-name"><span className="stage-section-marker"/><strong>{t('stage.staged')}</strong><span className="stage-section-count">{stagedFiles.length}</span></div><div className="stage-section-actions"><button className="icon-tool-button" onClick={() => quickStash('staged', stagedFiles.length)} disabled={!stagedFiles.length || busy} title={t('stage.quickStashStaged')} aria-label={t('stage.quickStashStaged')}><Archive size={14}/></button><button className="icon-tool-button" onClick={() => unstage(stagedFiles.map((file) => file.path))} disabled={!stagedFiles.length || busy} title={t('stage.unstageAll')} aria-label={t('stage.unstageAll')}><Minus size={14}/></button></div></div>
            {sectionOpen.staged && <div className="stage-section-files">{stagedFiles.length ? stagedFiles.map((file) => fileRow(file, () => unstage([file.path]), 'remove', 'staged')) : <div className="stage-empty">{t('stage.noStagedFiles')}</div>}</div>}
          </div>
          <div className={`stage-section unstaged-section ${sectionOpen.unstaged ? '' : 'collapsed'}`}>
            <div className="stage-section-header"><button type="button" className="stage-section-toggle" onClick={() => setSectionOpen((value) => ({ ...value, unstaged: !value.unstaged }))} aria-expanded={sectionOpen.unstaged} title={sectionOpen.unstaged ? t('stage.collapseUnstaged') : t('stage.expandUnstaged')}><ChevronDown size={14}/></button><div className="stage-section-name"><span className="stage-section-marker"/><strong>{t('stage.unstaged')}</strong><span className="stage-section-count">{unstagedFiles.length}</span></div><div className="stage-section-actions"><Button variant="danger" className="icon-tool-button" onClick={() => void discard(unstagedFiles.map((file) => file.path))} disabled={!unstagedFiles.length || busy} title={t('stage.discardAllUnstaged')} aria-label={t('stage.discardAllUnstaged')}><Trash2 size={14}/></Button><button className="icon-tool-button" onClick={() => quickStash('unstaged', unstagedFiles.length)} disabled={!unstagedFiles.length || busy} title={t('stage.quickStashUnstaged')} aria-label={t('stage.quickStashUnstaged')}><Archive size={14}/></button><button className="icon-tool-button" onClick={() => stage(unstagedFiles.map((file) => file.path))} disabled={!unstagedFiles.length || busy} title={t('stage.stageAll')} aria-label={t('stage.stageAll')}><Plus size={14}/></button></div></div>
            {sectionOpen.unstaged && <div className="stage-section-files">{unstagedFiles.length ? unstagedFiles.map((file) => fileRow(file, () => stage([file.path]), 'add', 'unstaged')) : <div className="stage-empty"><Check size={14}/> {t('stage.cleanWorktree')}</div>}</div>}
          </div>
        </div>
        <span className={`workspace-resizer workspace-resizer-row ${filesHeight.resizing ? 'active' : ''}`} role="separator" aria-label={t('stage.filesResizer')} onPointerDown={filesHeight.beginResize}/>
        <div className="commit-compose"><div className="template-row"><span title={repository?.commitTemplate?.path}><FileText size={14}/> {repository?.commitTemplate ? `模板：${fileName(repository.commitTemplate.path)}` : t('stage.noCommitTemplate')}</span><div className="template-row-actions"><button type="button" className="template-icon-button" onClick={applyConfiguredTemplate} disabled={!repository?.commitTemplate} title={t('stage.reapplyTemplate')} aria-label={t('stage.reapplyTemplate')}><RefreshCw size={14}/></button><button type="button" className="template-icon-button" onClick={() => { setTemplateDraft(repository?.commitTemplate?.content ?? ''); setTemplateEditorOpen(true) }} title={t('stage.editTemplate')} aria-label={t('stage.editTemplate')}><Pencil size={14}/></button></div></div><textarea className="commit-full-message" value={fullMessage} onChange={(event) => setFullMessage(event.target.value)} aria-label={t('stage.fullCommitMessage')} placeholder={t('stage.fullCommitMessagePlaceholder')} spellCheck={false}/><CommitMessageAssistant repositoryPath={repository?.path ?? ''} currentMessage={fullMessage} onApply={setFullMessage} onNotice={onNotice}/><div className="commit-options"><label><input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)}/> Amend</label><label><input type="checkbox" checked={sign} onChange={(event) => setSign(event.target.checked)}/> {t('stage.sign')}</label></div><Button variant="primary" onClick={commit} disabled={commitButton.disabled}><GitCommitHorizontal size={16}/> {commitButton.label} <span>⌘↵</span></Button></div>
      </div>
      <span className={`workspace-resizer workspace-resizer-column ${stagingWidth.resizing ? 'active' : ''}`} role="separator" aria-label={t('stage.panesResizer')} onPointerDown={stagingWidth.beginResize}/>
      <div className="staging-preview-pane">{selectedDiffEntry ? <DiffPanel files={[selectedDiffEntry.file]} repositoryPath={repository?.path} loadRows={loadStagingRows} viewKey={stageSelectionKey(selectedFile)} reloadKey={String(diffRevision)} wide={widePreview} onWideChange={setWidePreview} hideFileList actionScope={selectedDiffEntry.scope} actionsBusy={busy} onStagePatch={(_path, patch, description) => void applySelectedPatch('stage', patch, description)} onRestorePatch={(_path, patch, description) => void applySelectedPatch('restore', patch, description)} onUnstagePatch={(_path, patch, description) => void applySelectedPatch('unstage', patch, description)} onOpenLineHistory={(path, line, _side, row) => { if (row.kind === 'add') onNotice(t('stage.workingLineNoHistory')); else onOpenLineHistory(path, row.old ?? line) }}/>: <div className="drawer-preview-empty"><FileCode2 size={30}/><strong>{t('stage.pickFile')}</strong><span>{t('stage.pickFileHint')}</span></div>}</div>
    </div>
    {templateEditorOpen && <div className="template-editor-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) setTemplateEditorOpen(false) }}><section className="template-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="template-editor-title"><header className="template-editor-heading"><div><h2 id="template-editor-title">{t('stage.templateEditorTitle')}</h2><span title={repository?.commitTemplate?.path}>{repository?.commitTemplate?.path ?? t('stage.templateEditorSubtitle')}</span></div><button type="button" className="template-editor-close" onClick={() => setTemplateEditorOpen(false)} disabled={busy} aria-label={t('stage.closeTemplateEditor')}>×</button></header><div className="template-editor-body"><textarea value={templateDraft} onChange={(event) => setTemplateDraft(event.target.value)} aria-label={t('stage.templateEditorLabel')} placeholder={t('stage.templateEditorPlaceholder')} spellCheck={false} autoFocus /></div><footer className="template-editor-actions"><Button variant="secondary" onClick={() => setTemplateEditorOpen(false)} disabled={busy}>{t('common.cancel')}</Button><Button variant="secondary" onClick={() => void restoreGlobalTemplate()} disabled={busy}>{t('stage.restoreGlobalTemplate')}</Button><Button variant="primary" onClick={() => void saveRepositoryTemplate()} disabled={busy}>{t('stage.saveRepositoryTemplate')}</Button></footer></section></div>}
    {contextFile && <ContextMenu x={contextFile.x} y={contextFile.y} onClose={() => setContextFile(null)}><div className="context-menu-title"><FileText size={13}/><span>{contextFile.file.path}</span></div><button onClick={() => { onOpenHistory(contextFile.file.path, 'history'); setContextFile(null) }}><History size={14}/><span>{t('stage.fileHistory')}</span></button><button onClick={() => { onOpenHistory(contextFile.file.path, 'blame'); setContextFile(null) }}><Rows3 size={14}/><span>{t('stage.fileBlame')}</span></button><div className="context-menu-separator"/><button onClick={() => { navigator.clipboard?.writeText(contextFile.file.path).catch(() => undefined); setContextFile(null) }}><Copy size={14}/><span>{t('stage.copyFilePath')}</span></button>{contextFile.scope === 'unstaged' && <><div className="context-menu-separator"/><Button variant="danger" onClick={() => { const path = contextFile.file.path; setContextFile(null); void discard([path]) }}><Trash2 size={14}/><span>{t('stage.discardUnstagedProgress')}</span></Button></>}</ContextMenu>}
    {confirmDialog}
  </section>
}
