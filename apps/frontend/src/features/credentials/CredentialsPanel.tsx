import { useI18n } from '../../i18n'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Copy, HardDrive, KeyRound, Plus, RefreshCw, ShieldCheck, TerminalSquare, Trash2 } from 'lucide-react'
import { Button } from '../../components/Button'
import type { ConfirmDialogOptions } from '../../components/ConfirmDialog'
import {
  deleteSshKey,
  generateSshKey,
  getCredentialHelpers,
  loadGitRuntimeInfo,
  loadSshKeys,
  readSshPublicKey,
  setCredentialHelper,
  setCustomGitDirectory,
  type GitRuntimeInfo,
  type SshKeyInfo,
} from '../../repository'
import {
  SIMPLE_CREDENTIAL_HELPERS,
  buildCacheHelper,
  credentialHelperRisk,
  formatFingerprint,
  sshKeyBitsLabel,
  sshKeyTypeLabel,
  validateCredentialHelper,
  validateSshKeyForm,
  type CredentialScope,
  type SshKeyType,
} from './credentialsModel'

export type CredentialsPanelProps = {
  repositoryPath?: string
  confirm?: (options: ConfirmDialogOptions) => Promise<boolean>
  onNotice?: (message: string) => void
  onChanged?: () => void
}

const HELPER_LABELS: Record<string, string> = {
  '': '不配置 / 清除',
  osxkeychain: 'osxkeychain（macOS 钥匙串）',
  manager: 'manager（Git Credential Manager）',
  'manager-core': 'manager-core（旧版 GCM）',
  libsecret: 'libsecret（Linux 密钥环）',
  wincred: 'wincred（Windows 凭据管理器）',
  store: 'store（明文文件，有风险）',
  cache: 'cache（内存缓存）',
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

function RuntimeField({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="credentials-field">
      <span>{label}</span>
      <strong className={mono ? 'credentials-mono' : undefined} title={value ?? undefined}>
        {value ?? '未检测到'}
      </strong>
    </div>
  )
}

type KeyForm = {
  fileName: string
  keyType: SshKeyType
  bits: string
  comment: string
  overwrite: boolean
}

export function CredentialsPanel({ repositoryPath, confirm, onNotice, onChanged }: CredentialsPanelProps) {
  const { t } = useI18n()
  const [runtime, setRuntime] = useState<GitRuntimeInfo | null>(null)
  const [keys, setKeys] = useState<SshKeyInfo[]>([])
  const [helpers, setHelpers] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [customDir, setCustomDir] = useState('')
  const [scope, setScope] = useState<CredentialScope>('global')
  const [preset, setPreset] = useState('osxkeychain')
  const [cacheSeconds, setCacheSeconds] = useState('300')
  const [form, setForm] = useState<KeyForm>({
    fileName: 'id_ed25519',
    keyType: 'ed25519',
    bits: '3072',
    comment: '',
    overwrite: false,
  })

  const ask = useCallback(
    async (options: ConfirmDialogOptions) => {
      if (confirm) return confirm(options)
      return window.confirm(options.message)
    },
    [confirm],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextRuntime, nextKeys] = await Promise.all([loadGitRuntimeInfo(), loadSshKeys()])
      setRuntime(nextRuntime)
      setKeys(nextKeys)
      setCustomDir(nextRuntime.customGitDir ?? '')
      const current = await getCredentialHelpers(scope === 'local' ? repositoryPath ?? null : null)
      setHelpers(current)
      const first = current[0]
      if (first) {
        if (first.startsWith('cache --timeout=')) {
          setPreset('cache')
          setCacheSeconds(first.slice('cache --timeout='.length))
        } else if ((SIMPLE_CREDENTIAL_HELPERS as readonly string[]).includes(first)) {
          setPreset(first)
        }
      }
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }, [repositoryPath, scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!repositoryPath && scope === 'local') setScope('global')
  }, [repositoryPath, scope])

  const candidateHelper = preset === 'cache' ? buildCacheHelper(cacheSeconds) : preset
  const helperValidation = useMemo(() => validateCredentialHelper(candidateHelper, t), [candidateHelper])
  const helperRisk = useMemo(() => credentialHelperRisk(candidateHelper, t), [candidateHelper])

  const applyHelper = async () => {
    if (!helperValidation.ok) {
      setError(helperValidation.error)
      return
    }
    if (scope === 'local' && !repositoryPath) {
      setError('仓库级凭据助手需要先打开一个仓库')
      return
    }
    if (helperRisk) {
      const proceed = await ask({
        title: '确认凭据存储方式',
        message: `${helperRisk}\n\n仍然应用该凭据助手吗？`,
        confirmLabel: '仍然应用',
      })
      if (!proceed) return
    }
    setBusy('helper')
    setError(null)
    try {
      const report = await setCredentialHelper(
        scope,
        scope === 'local' ? repositoryPath ?? null : null,
        helperValidation.value,
      )
      setHelpers(report.configuredHelpers)
      if (!helperValidation.value) {
        setPreset('')
      } else if (helperValidation.value.startsWith('cache --timeout=')) {
        setPreset('cache')
        setCacheSeconds(helperValidation.value.slice('cache --timeout='.length))
      } else {
        setPreset(helperValidation.value)
      }
      onNotice?.(
        report.notice ??
          (helperValidation.value
            ? `已把 ${scope} 凭据助手设置为 ${helperValidation.value}`
            : `已清除 ${scope} 凭据助手`),
      )
      onChanged?.()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  const applyCustomDir = async () => {
    setBusy('custom-git')
    setError(null)
    try {
      const saved = await setCustomGitDirectory(customDir.trim() || null)
      setCustomDir(saved ?? '')
      onNotice?.(saved ? `已使用自定义 Git 目录：${saved}` : '已清除自定义 Git 目录，回落到系统 Git')
      onChanged?.()
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  const clearCustomDir = async () => {
    setBusy('custom-git')
    setError(null)
    try {
      await setCustomGitDirectory(null)
      setCustomDir('')
      onNotice?.('已清除自定义 Git 目录，回落到系统 Git')
      onChanged?.()
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  const submitKey = async (event: FormEvent) => {
    event.preventDefault()
    const validation = validateSshKeyForm(form, t)
    if (!validation.ok) {
      setError(validation.error)
      return
    }
    if (validation.values.overwrite) {
      const proceed = await ask({
        title: '覆盖 SSH 密钥',
        message: `将删除并重新生成 ${validation.values.fileName}（含配对的 .pub），旧密钥无法恢复。`,
        confirmLabel: '覆盖',
        variant: 'danger',
      })
      if (!proceed) return
    }
    setBusy('generate')
    setError(null)
    try {
      const info = await generateSshKey(
        validation.values.fileName,
        validation.values.keyType,
        validation.values.bits,
        validation.values.comment,
        validation.values.overwrite,
      )
      onNotice?.(
        `已生成 ${info.fileName}（${sshKeyTypeLabel(info.keyType, t)}）。密钥为空口令；如需口令保护，请在此终端执行：ssh-keygen -p -f "${info.path}"`,
      )
      onChanged?.()
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  const copyPublicKey = async (key: SshKeyInfo) => {
    setBusy(`copy:${key.fileName}`)
    setError(null)
    try {
      const publicKey = await readSshPublicKey(key.fileName)
      await navigator.clipboard.writeText(publicKey.trim())
      onNotice?.(`已复制 ${key.fileName} 的公钥`)
    } catch (reason) {
      setError(`复制公钥失败：${errorText(reason)}`)
    } finally {
      setBusy(null)
    }
  }

  const removeKey = async (key: SshKeyInfo) => {
    const proceed = await ask({
      title: '删除 SSH 密钥',
      message: `将删除 ${key.fileName}${key.hasPublic ? ' 及配对的 .pub 公钥' : ' 的私钥'}；此操作不可撤销。`,
      confirmLabel: '删除',
      variant: 'danger',
    })
    if (!proceed) return
    setBusy(`delete:${key.fileName}`)
    setError(null)
    try {
      const removed = await deleteSshKey(key.fileName, key.hasPublic)
      onNotice?.(`已删除 SSH 密钥：${removed.join('、')}`)
      onChanged?.()
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="credentials-panel" aria-label="凭据与 Git 运行时">
      <header className="credentials-heading">
        <div>
          <h2>凭据与 Git 运行时</h2>
          <p>管理 SSH 密钥、credential.helper 与自定义 Git；所有敏感值都在 Rust 侧按白名单校验。</p>
        </div>
        <Button variant="secondary" size="compact" onClick={() => void refresh()} disabled={loading || busy !== null}>
          <RefreshCw className={loading ? 'spin' : undefined} size={13} /> 刷新
        </Button>
      </header>

      {error && (
        <div className="credentials-error" role="alert">
          {error}
        </div>
      )}

      <section className="credentials-card">
        <div className="credentials-card-title">
          <HardDrive size={14} />
          Git 运行时
          <small>{runtime?.bundledGitPresent ? '检测到内置 Git 目录' : '未附带内置 Git'}</small>
        </div>
        <div className="credentials-grid">
          <RuntimeField label="Git 版本" value={runtime?.gitVersion} />
          <RuntimeField label="Git 路径" value={runtime?.gitPath} mono />
          <RuntimeField label="SSH 版本" value={runtime?.sshVersion} />
          <RuntimeField label="Git LFS" value={runtime?.gitLfsVersion} />
          <RuntimeField label="自定义 Git" value={runtime?.customGitDir ?? '未配置'} mono />
          <RuntimeField
            label="ssh-agent"
            value={runtime?.sshAgentRunning ? `运行中（${runtime.sshAgentKeys.length} 个密钥）` : '未运行'}
          />
        </div>
        {runtime && runtime.sshAgentKeys.length > 0 && (
          <ul className="credentials-agent-list">
            {runtime.sshAgentKeys.map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
        )}
        <div className="credentials-actions">
          <input
            className="credentials-input"
            value={customDir}
            onChange={(event) => setCustomDir(event.target.value)}
            placeholder="包含可执行 git 的目录，例如 /opt/git/bin"
            aria-label="自定义 Git 目录"
            spellCheck={false}
          />
          <Button
            variant="secondary"
            size="compact"
            onClick={() => void applyCustomDir()}
            disabled={busy !== null || loading}
          >
            应用目录
          </Button>
          <Button
            variant="secondary"
            size="compact"
            onClick={() => void clearCustomDir()}
            disabled={busy !== null || !runtime?.customGitDir}
          >
            清除
          </Button>
        </div>
        <p className="credentials-muted">
          只接受「目录」而不是 git 二进制路径，目录内必须存在可执行 git 且 <code>git --version</code> 能成功。
          本应用安装包不附带 Git 二进制；若安装包旁存在 <code>Resources/git/bin</code> 会自动前置到 PATH，否则使用系统 Git。
        </p>
      </section>

      <section className="credentials-card">
        <div className="credentials-card-title">
          <KeyRound size={14} />
          SSH 密钥
          <small>{keys.length} 对 · 上限 500</small>
        </div>
        {loading && keys.length === 0 ? (
          <div className="credentials-empty">正在读取 ~/.ssh…</div>
        ) : keys.length === 0 ? (
          <div className="credentials-empty">尚未发现 SSH 密钥。可以在下方生成，或把已有密钥放入 ~/.ssh。</div>
        ) : (
          <table className="credentials-table">
            <thead>
              <tr>
                <th>文件</th>
                <th>类型</th>
                <th>位数</th>
                <th>指纹</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.fileName}>
                  <td>
                    <div className="credentials-key-name">
                      <KeyRound size={12} />
                      <strong title={key.path}>{key.fileName}</strong>
                      {key.hasPrivate && <span className="credentials-badge ok">私钥</span>}
                      {key.hasPublic && <span className="credentials-badge">公钥</span>}
                    </div>
                    {key.comment && (
                      <span className="credentials-muted" title={key.comment}>
                        {key.comment}
                      </span>
                    )}
                  </td>
                  <td>{sshKeyTypeLabel(key.keyType, t)}</td>
                  <td>{sshKeyBitsLabel(key.bits)}</td>
                  <td>
                    <span className="credentials-fingerprint" title={key.fingerprint ?? undefined}>
                      {formatFingerprint(key.fingerprint, 44)}
                    </span>
                  </td>
                  <td>
                    <div className="credentials-actions">
                      <Button
                        variant="icon"
                        size="compact"
                        title="复制公钥"
                        aria-label={`复制 ${key.fileName} 的公钥`}
                        onClick={() => void copyPublicKey(key)}
                        disabled={busy !== null || (!key.hasPublic && !key.hasPrivate)}
                      >
                        <Copy size={13} />
                      </Button>
                      <Button
                        variant="icon"
                        size="compact"
                        title="删除密钥"
                        aria-label={`删除 ${key.fileName}`}
                        onClick={() => void removeKey(key)}
                        disabled={busy !== null}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form className="credentials-form" onSubmit={(event) => void submitKey(event)}>
          <label className="credentials-field">
            <span>文件名</span>
            <input
              className="credentials-input"
              value={form.fileName}
              onChange={(event) => setForm((value) => ({ ...value, fileName: event.target.value }))}
              placeholder="id_ed25519"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="credentials-field">
            <span>类型</span>
            <select
              className="credentials-input"
              value={form.keyType}
              onChange={(event) => setForm((value) => ({ ...value, keyType: event.target.value as SshKeyType }))}
            >
              <option value="ed25519">Ed25519</option>
              <option value="rsa">RSA</option>
            </select>
          </label>
          <label className="credentials-field">
            <span>RSA 位数</span>
            <select
              className="credentials-input"
              value={form.bits}
              disabled={form.keyType !== 'rsa'}
              onChange={(event) => setForm((value) => ({ ...value, bits: event.target.value }))}
            >
              <option value="2048">2048</option>
              <option value="3072">3072</option>
              <option value="4096">4096</option>
            </select>
          </label>
          <label className="credentials-field">
            <span>注释（可选）</span>
            <input
              className="credentials-input"
              value={form.comment}
              onChange={(event) => setForm((value) => ({ ...value, comment: event.target.value }))}
              placeholder="例如 work@laptop"
              spellCheck={false}
            />
          </label>
          <label className="credentials-check">
            <input
              type="checkbox"
              checked={form.overwrite}
              onChange={(event) => setForm((value) => ({ ...value, overwrite: event.target.checked }))}
            />
            覆盖同名文件
          </label>
          <Button type="submit" variant="primary" size="compact" disabled={busy !== null}>
            <Plus size={13} /> 生成密钥
          </Button>
        </form>
        <p className="credentials-notice">
          <TerminalSquare size={12} /> 这里只生成空口令密钥，口令不会经过应用。生成后如需口令保护，请在终端执行{' '}
          <code>ssh-keygen -p -f ~/.ssh/&lt;文件名&gt;</code>。
        </p>
      </section>

      <section className="credentials-card">
        <div className="credentials-card-title">
          <ShieldCheck size={14} />
          凭据助手
          <small>credential.helper</small>
        </div>
        <div className="credentials-actions">
          <div className="credentials-segment" role="group" aria-label="凭据作用域">
            <button type="button" className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>
              全局
            </button>
            <button
              type="button"
              className={scope === 'local' ? 'active' : ''}
              onClick={() => setScope('local')}
              disabled={!repositoryPath}
              title={repositoryPath ? undefined : '需要先打开仓库'}
            >
              当前仓库
            </button>
          </div>
          <select
            className="credentials-input"
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
            aria-label="凭据助手"
          >
            {Object.entries(HELPER_LABELS).map(([value, label]) => (
              <option key={value || 'none'} value={value}>
                {label}
              </option>
            ))}
          </select>
          {preset === 'cache' && (
            <input
              className="credentials-input"
              value={cacheSeconds}
              onChange={(event) => setCacheSeconds(event.target.value)}
              inputMode="numeric"
              aria-label="缓存秒数"
              placeholder="300"
            />
          )}
          <Button
            variant="primary"
            size="compact"
            onClick={() => void applyHelper()}
            disabled={busy !== null || loading || !helperValidation.ok}
          >
            应用
          </Button>
        </div>
        {helperRisk && <div className="credentials-notice">{helperRisk}</div>}
        {!helperValidation.ok && <div className="credentials-error">{helperValidation.error}</div>}
        <div className="credentials-field">
          <span>当前已配置</span>
          <strong className="credentials-mono">{helpers.length > 0 ? helpers.join('、') : '未配置'}</strong>
        </div>
        <p className="credentials-muted">
          凭据助手最终由 Git 通过 shell 执行，因此只接受固定白名单（含 <code>cache --timeout=</code>），
          其他字符串会被拒绝；仓库级配置只写入当前仓库的 <code>.git/config</code>。
        </p>
      </section>
    </section>
  )
}
