import { useState } from 'react'
import { Tag, X } from 'lucide-react'
import { Button } from '../../components/Button'

export type CreateTagPayload = {
  tag: string
  commit: string
  message: string
  /** false = 注释标签（-a），true = 签名标签（-s） */
  signed: boolean
  signingKey?: string
  /** 允许把已存在的同名标签移动到新提交（仍需后端二次确认） */
  force: boolean
}

/**
 * 创建注释 / 签名标签。轻量标签不在这里提供 —— 它没有打标签人与说明，
 * 竞品里也只在「快速标签」场景使用，本项目统一走注释标签以保证可追溯。
 */
export function CreateTagDialog({ existingTags, defaultCommit, busy, onClose, onSubmit }: {
  existingTags: string[]
  defaultCommit: string
  busy: boolean
  onClose: () => void
  onSubmit: (payload: CreateTagPayload) => Promise<void>
}) {
  const [tag, setTag] = useState('')
  const [commit, setCommit] = useState(defaultCommit || 'HEAD')
  const [message, setMessage] = useState('')
  const [signed, setSigned] = useState(false)
  const [signingKey, setSigningKey] = useState('')
  const [force, setForce] = useState(false)
  const name = tag.trim()
  const taken = existingTags.includes(name)
  const valid = name.length > 0 && !name.startsWith('-') && message.trim().length > 0 && commit.trim().length > 0 && (!taken || force)
  const key = signingKey.trim()

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="branch-dialog worktree-dialog" role="dialog" aria-modal="true" aria-label="创建标签">
      <div className="branch-dialog-heading"><span className="branch-dialog-icon"><Tag size={18}/></span><div><h2>创建标签</h2><p>注释标签会记录打标签人与说明；签名标签额外写入 GPG 签名。</p></div><Button variant="icon" onClick={onClose} disabled={busy} title="关闭"><X size={16}/></Button></div>
      <form onSubmit={(event) => { event.preventDefault(); if (valid) void onSubmit({ tag: name, commit: commit.trim(), message: message.trim(), signed, signingKey: key || undefined, force }) }}>
        <label>标签名称</label>
        <div className="branch-name-input"><input autoFocus value={tag} onChange={(event) => setTag(event.target.value)} placeholder="v1.2.0"/></div>
        {taken && <div className="branch-dialog-hint">{`标签 ${name} 已存在${force ? '，将按覆盖模式提交（仍需确认）' : '，请勾选覆盖模式或换个名称'}`}</div>}
        <label>目标提交</label>
        <div className="branch-name-input"><input value={commit} onChange={(event) => setCommit(event.target.value)} placeholder="HEAD、提交哈希或分支名"/></div>
        <label>标签类型</label>
        <div className="segmented worktree-mode">
          <button type="button" className={!signed ? 'active' : ''} onClick={() => setSigned(false)}>注释标签 -a</button>
          <button type="button" className={signed ? 'active' : ''} onClick={() => setSigned(true)}>签名标签 -s</button>
        </div>
        <label>标签说明（必填）</label>
        <div className="branch-name-input"><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="本次发布的要点"/></div>
        {signed && <>
          <label>签名密钥（可选，留空用 user.signingkey）</label>
          <div className="branch-name-input"><input value={signingKey} onChange={(event) => setSigningKey(event.target.value)} placeholder="密钥指纹或邮箱"/></div>
        </>}
        <label className="auto-fetch-toggle"><span><strong>覆盖同名标签</strong><small>会先把「从哪个提交移到哪个提交」给你确认</small></span><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)}/><span className="toggle-track" aria-hidden="true"><span/></span></label>
        <div className="branch-dialog-hint">签名标签需要本机 GPG 与可用私钥；签署失败时不会降级成轻量标签冒充已签名。</div>
        <div className="branch-dialog-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" variant="primary" disabled={!valid || busy}>{busy ? '正在创建…' : signed ? '创建签名标签' : '创建注释标签'}</Button></div>
      </form>
    </section>
  </div>
}
