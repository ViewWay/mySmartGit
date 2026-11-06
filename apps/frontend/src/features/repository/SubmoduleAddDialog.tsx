import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, RefreshCw, X } from 'lucide-react'
import { Button } from '../../components/Button'
import type { RepositorySubmodule } from '../../repository'
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
  const [draft, setDraft] = useState<SubmoduleAddDraft>({ url: '', path: '', name: '', branch: '' })
  const [touched, setTouched] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const errors = useMemo(() => validateSubmoduleDraft(draft, submodules), [draft, submodules])
  const notice = credentialNotice(draft.url)
  const derivedPath = draft.path.trim() || deriveSubmodulePath(draft.url)
  const valid = canSubmitSubmoduleDraft(draft, submodules)
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
        <div><h2 id="submodule-add-title">添加 Submodule</h2><p>把另一个仓库按指针登记进当前仓库；地址与目录都会先校验再交给 Git。</p></div>
        <Button variant="icon" onClick={onClose} disabled={busy} title="关闭"><X size={16}/></Button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        {field('url', '子模块地址', 'https://… / git@… / 本地仓库路径')}
        {field('path', '目录（留空按地址命名）', derivedPath || 'vendor/lib', `将写入 ${derivedPath || '（先填写地址）'}`)}
        {field('name', '段名（可选）', derivedPath || 'lib', '留空与目录同名；它同时是 .gitmodules 的段名')}
        {field('branch', '跟踪分支（可选）', 'main', '留空则固定跟随父仓库记录的提交')}
        {notice && <div className="branch-dialog-hint" role="alert">{notice}</div>}
        <div className="branch-dialog-hint">添加只会写入 .gitmodules 与索引里的指针，仍需提交才会进入历史；地址中的凭据不会回显到界面。</div>
        <div className="branch-dialog-actions">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>
            {busy ? <RefreshCw size={14} className="spin"/> : null}
            <span>{busy ? '正在添加…' : '添加 Submodule'}</span>
          </Button>
        </div>
      </form>
    </section>
  </div>
}
