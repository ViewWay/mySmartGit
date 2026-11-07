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

const HELPER_KEYS: Record<string, string> = {
  '': 'credentials.scopeNone',
  osxkeychain: 'credentials.helperOsxkeychain',
  'manager-core': 'credentials.helperManagerCore',
  libsecret: 'credentials.helperLibsecret',
  wincred: 'credentials.helperWincred',
  store: 'credentials.helperStore',
  cache: 'credentials.helperCache',
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

function RuntimeField({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  const { t } = useI18n()
  return (
    <div className="credentials-field">
      <span>{label}</span>
      <strong className={mono ? 'credentials-mono' : undefined} title={value ?? undefined}>
        {value ?? t('credentials.notDetected')}
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
      setError(t('credentials.repoScopeRequiresRepo'))
      return
    }
    if (helperRisk) {
      const proceed = await ask({
        title: t('credentials.confirmStorageTitle'),
        message: t('credentials.riskConfirm', { risk: helperRisk }),
        confirmLabel: t('credentials.applyAnyway'),
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
            ? t('credentials.helperSet', { scope, helper: helperValidation.value })
            : t('credentials.helperCleared', { scope })),
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
      onNotice?.(saved ? t('credentials.customGitUsed', { dir: saved }) : t('credentials.gitDirCleared'))
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
      onNotice?.(t('credentials.gitDirCleared'))
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
        title: t('credentials.overwriteKeyTitle'),
        message: t('credentials.overwriteKeyConfirm', { name: validation.values.fileName }),
        confirmLabel: t('credentials.overwrite'),
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
        t('credentials.keyGenerated', { name: info.fileName, type: sshKeyTypeLabel(info.keyType, t), path: info.path }),
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
      onNotice?.(t('credentials.pubKeyCopied', { name: key.fileName }))
    } catch (reason) {
      setError(t('credentials.pubKeyCopyFailed', { error: errorText(reason) }))
    } finally {
      setBusy(null)
    }
  }

  const removeKey = async (key: SshKeyInfo) => {
    const proceed = await ask({
      title: t('credentials.deleteKeyTitle'),
      message: t('credentials.deleteKeyConfirm', { name: key.fileName, extra: key.hasPublic ? t('credentials.deleteWithPubSuffix') : t('credentials.privateKeyOf') }),
      confirmLabel: t('credentials.delete'),
      variant: 'danger',
    })
    if (!proceed) return
    setBusy(`delete:${key.fileName}`)
    setError(null)
    try {
      const removed = await deleteSshKey(key.fileName, key.hasPublic)
      onNotice?.(t('credentials.keysDeleted', { names: removed.join('、') }))
      onChanged?.()
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="credentials-panel" aria-label={t('credentials.title')}>
      <header className="credentials-heading">
        <div>
          <h2>{t('credentials.title')}</h2>
          <p>{t('credentials.subtitleFull')}</p>
        </div>
        <Button variant="secondary" size="compact" onClick={() => void refresh()} disabled={loading || busy !== null}>
          <RefreshCw className={loading ? 'spin' : undefined} size={13} /> {t('credentials.refresh')}
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
          {t('credentials.gitRuntime')}
          <small>{runtime?.bundledGitPresent ? t('credentials.bundledGitFound') : t('credentials.noBundledGit')}</small>
        </div>
        <div className="credentials-grid">
          <RuntimeField label={t('credentials.gitVersion')} value={runtime?.gitVersion} />
          <RuntimeField label={t('credentials.gitPath')} value={runtime?.gitPath} mono />
          <RuntimeField label={t('credentials.sshVersion')} value={runtime?.sshVersion} />
          <RuntimeField label={t('credentials.gitLfs')} value={runtime?.gitLfsVersion} />
          <RuntimeField label={t('credentials.customGit')} value={runtime?.customGitDir ?? t('credentials.notConfigured')} mono />
          <RuntimeField
            label="ssh-agent"
            value={runtime?.sshAgentRunning ? t('credentials.agentRunning', { count: runtime.sshAgentKeys.length }) : t('credentials.notRunning')}
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
            placeholder={t('credentials.customGitPlaceholder')}
            aria-label={t('credentials.customGitLabel')}
            spellCheck={false}
          />
          <Button
            variant="secondary"
            size="compact"
            onClick={() => void applyCustomDir()}
            disabled={busy !== null || loading}
          >
            {t('credentials.applyDir')}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            onClick={() => void clearCustomDir()}
            disabled={busy !== null || !runtime?.customGitDir}
          >
            {t('credentials.clear')}
          </Button>
        </div>
        <p className="credentials-muted">
          {t('credentials.customGitHint')} <code>git --version</code> {t('credentials.customGitHintSuffix')} <code>Resources/git/bin</code> {t('credentials.customGitHintSuffix2')}
        </p>
      </section>

      <section className="credentials-card">
        <div className="credentials-card-title">
          <KeyRound size={14} />
          {t('credentials.sshKeys')}
          <small>{t('credentials.keyPairs', { count: keys.length })}</small>
        </div>
        {loading && keys.length === 0 ? (
          <div className="credentials-empty">{t('credentials.readingSsh')}</div>
        ) : keys.length === 0 ? (
          <div className="credentials-empty">{t('credentials.noKeys')}</div>
        ) : (
          <table className="credentials-table">
            <thead>
              <tr>
                <th>{t('credentials.file')}</th>
                <th>{t('credentials.type')}</th>
                <th>{t('credentials.bits')}</th>
                <th>{t('credentials.fingerprint')}</th>
                <th>{t('credentials.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.fileName}>
                  <td>
                    <div className="credentials-key-name">
                      <KeyRound size={12} />
                      <strong title={key.path}>{key.fileName}</strong>
                      {key.hasPrivate && <span className="credentials-badge ok">{t('credentials.privateKey')}</span>}
                      {key.hasPublic && <span className="credentials-badge">{t('credentials.publicKey')}</span>}
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
                        title={t('credentials.copyPublicKey')}
                        aria-label={t('credentials.copyPubKeyFor', { name: key.fileName })}
                        onClick={() => void copyPublicKey(key)}
                        disabled={busy !== null || (!key.hasPublic && !key.hasPrivate)}
                      >
                        <Copy size={13} />
                      </Button>
                      <Button
                        variant="icon"
                        size="compact"
                        title={t('credentials.deleteKey')}
                        aria-label={t('credentials.deleteKeyFor', { name: key.fileName })}
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
            <span>{t('credentials.fileName')}</span>
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
            <span>{t('credentials.type')}</span>
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
            <span>{t('credentials.rsaBits')}</span>
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
            <span>{t('credentials.comment')}</span>
            <input
              className="credentials-input"
              value={form.comment}
              onChange={(event) => setForm((value) => ({ ...value, comment: event.target.value }))}
              placeholder={t('credentials.commentPlaceholder')}
              spellCheck={false}
            />
          </label>
          <label className="credentials-check">
            <input
              type="checkbox"
              checked={form.overwrite}
              onChange={(event) => setForm((value) => ({ ...value, overwrite: event.target.checked }))}
            />
            {t('credentials.overwriteSameName')}
          </label>
          <Button type="submit" variant="primary" size="compact" disabled={busy !== null}>
            <Plus size={13} /> {t('credentials.generateKey')}
          </Button>
        </form>
        <p className="credentials-notice">
          <TerminalSquare size={12} /> {t('credentials.noPassphraseNote')}{' '}
          <code>{t('credentials.sshKeygenCmd')}</code>.
        </p>
      </section>

      <section className="credentials-card">
        <div className="credentials-card-title">
          <ShieldCheck size={14} />
          {t('credentials.helperSection')}
          <small>credential.helper</small>
        </div>
        <div className="credentials-actions">
          <div className="credentials-segment" role="group" aria-label={t('credentials.scope')}>
            <button type="button" className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>
              {t('credentials.scopeGlobal')}
            </button>
            <button
              type="button"
              className={scope === 'local' ? 'active' : ''}
              onClick={() => setScope('local')}
              disabled={!repositoryPath}
              title={repositoryPath ? undefined : t('credentials.scopeRepoRequiresRepo')}
            >
              {t('credentials.scopeRepo')}
            </button>
          </div>
          <select
            className="credentials-input"
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
            aria-label={t('credentials.helperLabel')}
          >
            {Object.entries(HELPER_KEYS).map(([value, key]) => (
              <option key={value || 'none'} value={value}>
                {key === 'credentials.scopeNone' ? t('credentials.scopeNone') : value === 'manager' ? 'manager（Git Credential Manager）' : t(key)}
              </option>
            ))}
          </select>
          {preset === 'cache' && (
            <input
              className="credentials-input"
              value={cacheSeconds}
              onChange={(event) => setCacheSeconds(event.target.value)}
              inputMode="numeric"
              aria-label={t('credentials.cacheSeconds')}
              placeholder="300"
            />
          )}
          <Button
            variant="primary"
            size="compact"
            onClick={() => void applyHelper()}
            disabled={busy !== null || loading || !helperValidation.ok}
          >
            {t('credentials.apply')}
          </Button>
        </div>
        {helperRisk && <div className="credentials-notice">{helperRisk}</div>}
        {!helperValidation.ok && <div className="credentials-error">{helperValidation.error}</div>}
        <div className="credentials-field">
          <span>{t('credentials.currentlyConfigured')}</span>
          <strong className="credentials-mono">{helpers.length > 0 ? helpers.join('、') : t('credentials.notConfigured')}</strong>
        </div>
        <p className="credentials-muted">
          {t('credentials.helperShellNote')} <code>cache --timeout=</code>{t('credentials.helperShellNoteSuffix')} <code>.git/config</code>。
        </p>
      </section>
    </section>
  )
}
