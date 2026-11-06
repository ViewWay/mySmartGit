import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, RefreshCw, X } from 'lucide-react'
import { Button } from '../../components/Button'
import type { RepositorySubmodule } from '../../repository'
import { useI18n } from '../../i18n'
import {
  canSubmitSubmoduleDraft,
  credentialNotice,
  deriveSubmodulePath,
  validateSubmoduleDraft,
  type SubmoduleAddDraft,
} from './submoduleAddForm'

/**
 * 添加 Submodule 表单（W2-10）。
 *
 * 提交约定与远程管理一致：先以 confirm=false 调用拿「预览」，
 * 后端返回 requiresConfirmation=true 时仓库没有被改动，由父级确认后
 * 再带 confirm=true 调一次。这里只负责收集与本地校验，不直接碰 Git。
 */
export function SubmoduleAddDialog({ submodules, busy, onClose, onSubmit }: {
  submodules: RepositorySubmodule[]
  busy: boolean
  onClose: () => void
  /**
   * 由父级执行「预览 → 二次确认 → 执行」的完整流程。
   * 返回 true 表示子模块已落地，可以关闭对话框；返回 false 时保留用户输入继续改。
   */
  onSubmit: (draft: SubmoduleAddDraft) => Promise<boolean>
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<SubmoduleAddDraft>({ url: '', path: '', name: '', branch: '' })
  const [touched, setTouched] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const errors = useMemo(() => validateSubmoduleDraft(draft, submodules, t), [draft, submodules, t])
  const notice = credentialNotice(draft.url, t)
  const derivedPath = draft.path.trim() || deriveSubmodulePath(draft.url)
  const valid = canSubmitSubmoduleDraft(draft, submodules, t)
  useEffect(() => {
    dialogRef.current?.querySelector('input')?.focus()
  }, [])

  const submit = async () => {
    if (!valid || busy) return
    setTouched(true)
    const cleaned: SubmoduleAddDraft = {
      url: draft.url.trim(),
      path: draft.path.trim(),
      name: draft.name.trim(),
      branch: draft.branch.trim(),
    }
    if (await onSubmit(cleaned)) {
      setDraft({ url: '', path: '', name: '', branch: '' })
      setTouched(false)
    }
  }

  const field = (key: keyof SubmoduleAddDraft, label: string, placeholder: string, hint?: string) => (
    <label>{label}
      <div className={touched && errors[key] ? 'branch-name-input invalid' : 'branch-name-input'}><input
        value={draft[key]}
        spellCheck={false}
        placeholder={placeholder}
        disabled={busy}
        aria-invalid={Boolean(touched && errors[key])}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        onBlur={() => setTouched(true)}
      /></div>
      {touched && errors[key] && <span className="repository-inline-error" role="alert">{errors[key]}</span>}
      {!errors[key] && hint && <small>{hint}</small>}
    </label>
  )

  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="branch-dialog worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="submodule-add-title">
      <div className="branch-dialog-heading">
        <span className="branch-dialog-icon"><Box size={18}/></span>
        <div><h2 id="submodule-add-title">{t('repository.submoduleAdd.title')}</h2><p>{t('repository.submoduleAdd.subtitle')}</p></div>
        <Button variant="icon" onClick={onClose} disabled={busy} title={t('common.close')}><X size={16}/></Button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        {field('url', t('repository.submoduleAdd.url'), t('repository.add.sourcePlaceholder'))}
        {field('path', t('repository.submoduleAdd.path'), derivedPath || 'vendor/lib', t('repository.submoduleAdd.willWrite', { path: derivedPath || t('repository.submoduleAdd.fillUrlFirst') }))}
        {field('name', t('repository.submoduleAdd.name'), derivedPath || 'lib', t('repository.submoduleAdd.nameHint'))}
        {field('branch', t('repository.submoduleAdd.branch'), 'main', t('repository.submoduleAdd.branchHint'))}
        {notice && <div className="branch-dialog-hint" role="alert">{notice}</div>}
        <div className="branch-dialog-hint">{t('repository.submoduleAdd.gitmodulesNote')}</div>
        <div className="branch-dialog-actions">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>
            {busy ? <RefreshCw size={14} className="spin"/> : null}
            <span>{busy ? t('repository.submoduleAdd.adding') : t('repository.submoduleAdd.title')}</span>
          </Button>
        </div>
      </form>
    </section>
  </div>
}
