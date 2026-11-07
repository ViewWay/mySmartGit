import { useI18n } from '../../i18n'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitPullRequest,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  X,
} from 'lucide-react'
import { Button } from '../../components/Button'
import type { ConfirmDialogOptions } from '../../components/ConfirmDialog'
import {
  clearHostingToken,
  createHostingPullRequest,
  detectHostingRepository,
  listHostingPullRequests,
  loadHostingPullRequest,
  loadHostingSettings,
  loadRepository,
  saveHostingSettings,
  type HostingProvider,
  type HostingPullRequest,
  type HostingPullRequestDetail,
  type HostingRepository,
  type HostingSettings,
} from '../../repository'
import {
  buildCreatePullRequestInput,
  hostingCiLabel,
  hostingCiTone,
  hostingDefaultHost,
  hostingProviderLabel,
  hostingSettingsSummary,
  inferDefaultBranch,
  isHostingProvider,
  pullRequestBranchLabel,
  summarizePullRequest,
  validateCreatePullRequestForm,
  validateHostingHost,
  validateHostingToken,
  type CreatePullRequestForm,
} from './hostingModel'

/**
 * GitHub / GitLab 协作面板（W4-1）。
 *
 * - 设置与仓库识别分离：没有 origin 远端时仍可保存令牌，只是列表 / 创建不可用；
 * - 令牌只写后端 0600 文件，密码框永不回显；留空保存表示保留原令牌；
 * - 列表中的 CI 状态固定为 unknown（后端不做 N+1 请求），点击详情才读取检查；
 * - 创建表单默认取当前分支与列表推断的默认分支，GitLab 不显示草稿复选框；
 * - 复制链接失败时通过 onNotice 提示手动复制，不使用 alert。
 */
export type HostingPanelProps = {
  repositoryPath: string
  onNotice?: (message: string) => void
  confirm?: (options: ConfirmDialogOptions) => Promise<boolean>
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function mergeableLabel(value: boolean | null, t: (key: string, params?: Record<string, string | number>) => string): { text: string; tone: string } {
  if (value === true) return { text: t('hosting.mergeable'), tone: 'ok' }
  if (value === false) return { text: t('hosting.notMergeable'), tone: 'warn' }
  return { text: t('hosting.mergeUnknown'), tone: 'unknown' }
}

const EMPTY_FORM: CreatePullRequestForm = {
  title: '',
  body: '',
  sourceBranch: '',
  targetBranch: 'main',
  draft: false,
}

export function HostingPanel({ repositoryPath, onNotice, confirm }: HostingPanelProps) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<HostingSettings | null>(null)
  const [repository, setRepository] = useState<HostingRepository | null>(null)
  const [repositoryError, setRepositoryError] = useState('')
  const [pullRequests, setPullRequests] = useState<HostingPullRequest[]>([])
  const [detail, setDetail] = useState<HostingPullRequestDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [provider, setProvider] = useState<HostingProvider>('github')
  const [host, setHost] = useState('')
  const [token, setToken] = useState('')
  const [currentBranch, setCurrentBranch] = useState('')
  const [form, setForm] = useState<CreatePullRequestForm>(EMPTY_FORM)

  const notify = useCallback((message: string) => onNotice?.(message), [onNotice])

  const refreshList = useCallback(async () => {
    if (!repositoryPath) return
    setListLoading(true)
    setError('')
    try {
      const items = await listHostingPullRequests(repositoryPath)
      setPullRequests(items)
      const inferred = inferDefaultBranch(items)
      setForm((previous) =>
        previous.targetBranch === 'main' && inferred !== 'main'
          ? { ...previous, targetBranch: inferred }
          : previous,
      )
    } catch (reason) {
      setPullRequests([])
      setError(errorText(reason))
    } finally {
      setListLoading(false)
    }
  }, [repositoryPath])

  useEffect(() => {
    if (!repositoryPath) return
    let cancelled = false
    setSettings(null)
    setRepository(null)
    setRepositoryError('')
    setPullRequests([])
    setDetail(null)
    setError('')
    setCurrentBranch('')
    setHost('')
    setToken('')
    setForm(EMPTY_FORM)

    const run = async () => {
      setLoading(true)
      try {
        const next = await loadHostingSettings()
        if (cancelled) return
        setSettings(next)
        setProvider(next.provider)
        setHost(next.host ?? '')
        if (next.tokenConfigured) void refreshList()
      } catch (reason) {
        if (!cancelled) setError(errorText(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
      if (cancelled) return

      try {
        const nextRepository = await detectHostingRepository(repositoryPath)
        if (!cancelled) setRepository(nextRepository)
      } catch (reason) {
        if (!cancelled) setRepositoryError(errorText(reason))
      }
      try {
        const snapshot = await loadRepository(repositoryPath)
        if (!cancelled) setCurrentBranch(snapshot.branch)
      } catch {
        // 当前分支只是表单默认值，读取失败不阻断面板。
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [repositoryPath, refreshList])

  useEffect(() => {
    if (currentBranch) {
      setForm((previous) =>
        previous.sourceBranch ? previous : { ...previous, sourceBranch: currentBranch },
      )
    }
  }, [currentBranch])

  const copyUrl = async (url: string) => {
    if (!navigator.clipboard) {
      notify(t('hosting.copyUnsupported', { url }))
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      notify(t('hosting.linkCopied'))
    } catch {
      notify(t('hosting.copyFailed', { url }))
    }
  }

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault()
    const hostError = validateHostingHost(host, provider, t)
    if (hostError) {
      setError(hostError)
      return
    }
    const tokenError = validateHostingToken(token, t)
    if (tokenError) {
      setError(tokenError)
      return
    }
    setBusy('settings')
    setError('')
    try {
      const next = await saveHostingSettings(
        provider,
        host.trim() ? host.trim() : null,
        token.trim() ? token.trim() : null,
      )
      setSettings(next)
      setProvider(next.provider)
      setHost(next.host ?? '')
      setToken('')
      notify(next.tokenConfigured ? t('hosting.settingsSavedWithToken') : t('hosting.settingsSaved'))
      if (next.tokenConfigured) void refreshList()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  const clearToken = async () => {
    const options: ConfirmDialogOptions = {
      title: t('hosting.clearTokenTitle'),
      message: t('hosting.clearTokenMessage'),
      confirmLabel: t('hosting.clearTokenConfirm'),
      variant: 'danger',
    }
    const accepted = confirm
      ? await confirm(options)
      : window.confirm(`${options.title}\n\n${options.message}`)
    if (!accepted) {
      notify(t('hosting.clearCancelled'))
      return
    }
    setBusy('clear')
    setError('')
    try {
      const next = await clearHostingToken()
      setSettings(next)
      setPullRequests([])
      setDetail(null)
      notify(t('hosting.tokenCleared'))
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  const openDetail = async (number: number) => {
    setDetailLoading(true)
    setDetail(null)
    setError('')
    try {
      setDetail(await loadHostingPullRequest(repositoryPath, number))
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setDetailLoading(false)
    }
  }

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    const invalid = validateCreatePullRequestForm(form, provider, t)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy('create')
    setError('')
    try {
      const effectiveProvider = repository?.provider ?? provider
      const created = await createHostingPullRequest(
        repositoryPath,
        buildCreatePullRequestInput(form, effectiveProvider),
      )
      notify(t('hosting.createdPullRequest', { noun: effectiveProvider === 'gitlab' ? 'MR' : 'PR', number: created.number }))
      setForm((previous) => ({
        ...previous,
        title: '',
        body: '',
        draft: false,
        targetBranch: previous.targetBranch || 'main',
      }))
      await refreshList()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  if (!repositoryPath) {
    return (
      <section className="workspace-empty">
        <GitPullRequest size={34} />
        <strong>{t('hosting.panelTitle')}</strong>
        <span>{t('hosting.requiresRepository')}</span>
      </section>
    )
  }

  const disabled = loading || busy !== null
  const tokenReady = settings?.tokenConfigured === true
  const effectiveProvider = repository?.provider ?? provider
  const noun = effectiveProvider === 'gitlab' ? 'MR' : 'PR'
  const mergeable = detail ? mergeableLabel(detail.mergeable, t) : null

  return (
    <section className="structure-panel workspace-page hosting-panel">
      <div className="workspace-page-heading">
        <div>
          <span className="eyebrow">{t('hosting.cardTitle')}</span>
          <h2>{t('hosting.panelTitle')}</h2>
          <p>{hostingSettingsSummary(settings, t)}</p>
        </div>
        <div className="structure-actions">
          <Button
            variant="secondary"
            disabled={disabled || listLoading || !tokenReady}
            onClick={() => void refreshList()}
          >
            <RefreshCw size={14} className={listLoading ? 'spin' : ''} />
            {listLoading ? t('hosting.loadingList') : t('hosting.refreshList')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="hosting-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <Button variant="icon" onClick={() => setError('')} title={t('common.close')}>
            <X size={14} />
          </Button>
        </div>
      )}

      <div className="hosting-grid">
        <article className="structure-detail-card hosting-card">
          <div className="hosting-card-heading">
            <h3>
              <Settings2 size={15} />
              {t('hosting.settingsSection')}
            </h3>
            <span className={`hosting-badge ${tokenReady ? 'ok' : 'warn'}`}>
              {tokenReady ? t('hosting.tokenConfigured') : t('hosting.tokenMissing')}
            </span>
          </div>
          <p className="hosting-card-hint">
            {t('hosting.tokenNote')}
          </p>
          <form className="hosting-form" onSubmit={(event) => void saveSettings(event)}>
            <label className="hosting-field">
              <span>{t('hosting.providerLabel')}</span>
              <select
                value={provider}
                disabled={disabled}
                onChange={(event) => {
                  const next = event.target.value
                  if (isHostingProvider(next)) setProvider(next)
                }}
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
            </label>
            <label className="hosting-field">
              <span>{t('hosting.hostLabel')}</span>
              <input
                value={host}
                spellCheck={false}
                disabled={disabled}
                placeholder={hostingDefaultHost(provider)}
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            <label className="hosting-field hosting-field-wide">
              <span>Personal Access Token</span>
              <input
                type="password"
                value={token}
                autoComplete="new-password"
                spellCheck={false}
                disabled={disabled}
                placeholder={tokenReady ? t('hosting.tokenPlaceholder') : t('hosting.tokenInputPlaceholder')}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <div className="hosting-actions hosting-field-wide">
              <Button variant="primary" type="submit" disabled={disabled}>
                <KeyRound size={14} />
                {busy === 'settings' ? t('hosting.savingSettings') : t('hosting.saveSettings')}
              </Button>
              <Button
                variant="danger"
                type="button"
                disabled={disabled || !tokenReady}
                onClick={() => void clearToken()}
              >
                <X size={14} />
                {busy === 'clear' ? t('hosting.clearing') : t('hosting.clearToken')}
              </Button>
            </div>
          </form>
        </article>

        <article className="structure-detail-card hosting-card">
          <div className="hosting-card-heading">
            <h3>
              <Server size={15} />
              {t('hosting.repoIdentify')}
            </h3>
            {repository && (
              <span className="hosting-badge ok">{hostingProviderLabel(repository.provider)}</span>
            )}
          </div>
          {repository ? (
            <dl className="hosting-detected">
              <div>
                <dt>{t('hosting.providerColumn')}</dt>
                <dd>{hostingProviderLabel(repository.provider)}</dd>
              </div>
              <div>
                <dt>{t('hosting.projectLabel')}</dt>
                <dd className="hosting-mono">{repository.projectPath}</dd>
              </div>
              <div>
                <dt>{t('hosting.hostColumn')}</dt>
                <dd className="hosting-mono">{repository.host}</dd>
              </div>
              <div>
                <dt>{t('hosting.webUrl')}</dt>
                <dd>
                  <button
                    type="button"
                    className="hosting-link-button"
                    title={t('hosting.copyWebUrl')}
                    onClick={() => void copyUrl(repository.webUrl)}
                  >
                    <Copy size={12} />
                    {repository.webUrl}
                  </button>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="hosting-empty">
              {loading ? t('hosting.readingOrigin') : repositoryError || t('hosting.noOrigin')}
            </p>
          )}
          {repositoryError && repository && (
            <p className="hosting-hint hosting-hint-warning">{repositoryError}</p>
          )}
        </article>
      </div>

      {(detailLoading || detail) && (
        <article className="structure-detail-card hosting-card hosting-detail">
          <div className="hosting-card-heading">
            <h3>
              <GitPullRequest size={15} />
              {t('hosting.detailTitle')}
            </h3>
            <Button variant="secondary" onClick={() => setDetail(null)}>
              <ChevronLeft size={14} />
              {t('hosting.backToList')}
            </Button>
          </div>
          {detailLoading && <p className="hosting-empty">{t('hosting.readingDetail')}</p>}
          {detail && (
            <>
              <h4 className="hosting-detail-title">
                #{detail.number} {detail.title}
              </h4>
              <p className="hosting-pr-meta">
                {detail.author} · {pullRequestBranchLabel(detail)} · {detail.state}
              </p>
              <div className="hosting-detail-flags">
                <span className={`hosting-ci hosting-ci-${hostingCiTone(detail.ciStatus)}`}>
                  {hostingCiLabel(detail.ciStatus, t)}
                </span>
                {mergeable && (
                  <span className={`hosting-badge ${mergeable.tone}`}>{mergeable.text}</span>
                )}
              </div>
              <div className="hosting-detail-body">
                <h5>{t('hosting.description')}</h5>
                <pre>{detail.body ?? t('hosting.noDescription')}</pre>
              </div>
              <div>
                <h5>{t('hosting.checksPrefix')}{detail.checks.length}）</h5>
                {detail.checks.length === 0 ? (
                  <p className="hosting-empty">{t('hosting.noChecks')}</p>
                ) : (
                  <ul className="hosting-check-list">
                    {detail.checks.map((check, index) => (
                      <li key={`${check.name}:${index}`} className="hosting-check-row">
                        <span className="hosting-check-name">{check.name}</span>
                        <span className="hosting-mono">
                          {check.status}
                          {check.conclusion ? ` · ${check.conclusion}` : ''}
                        </span>
                        {check.webUrl && (
                          <a href={check.webUrl} target="_blank" rel="noreferrer">
                            {t('hosting.view')}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <a className="hosting-external" href={detail.webUrl} target="_blank" rel="noreferrer">
                {t('hosting.openInBrowser')}
              </a>
            </>
          )}
        </article>
      )}

      <article className="structure-detail-card hosting-card">
        <div className="hosting-card-heading">
          <h3>
            <GitPullRequest size={15} />
            {t('hosting.stateOpenLabel')} {noun}（{pullRequests.length}）
          </h3>
        </div>
        {!tokenReady && (
          <p className="hosting-hint hosting-hint-warning">
            {t('hosting.tokenMissingNoticePrefix')} {hostingProviderLabel(effectiveProvider)}{' '}
            {t('hosting.tokenMissingNoticeSuffix')}
          </p>
        )}
        {listLoading && <p className="hosting-empty">{t('hosting.readingPullRequests')}</p>}
        {!listLoading && pullRequests.length === 0 && (
          <p className="hosting-empty">
            {tokenReady ? t('hosting.noOpenPullRequests') : t('hosting.tokenToRead')}
          </p>
        )}
        <ul className="hosting-pr-list">
          {pullRequests.map((pr) => (
            <li key={pr.number} className="hosting-pr">
              <div className="hosting-pr-main">
                <button
                  type="button"
                  className="hosting-pr-title"
                  onClick={() => void openDetail(pr.number)}
                >
                  <span className="hosting-pr-number">#{pr.number}</span>
                  <span>{pr.title}</span>
                  {pr.draft && <span className="hosting-badge">{t('hosting.stateDraft')}</span>}
                </button>
                <p className="hosting-pr-meta">{summarizePullRequest(pr, t)}</p>
              </div>
              <span className={`hosting-ci hosting-ci-${hostingCiTone(pr.ciStatus)}`}>
                {hostingCiLabel(pr.ciStatus, t)}
              </span>
              <Button
                variant="icon"
                title={t('hosting.copyLink')}
                aria-label={t('hosting.copyLinkAria', { number: pr.number })}
                onClick={() => void copyUrl(pr.webUrl)}
              >
                <Copy size={13} />
              </Button>
              <Button
                variant="icon"
                title={t('hosting.viewDetail')}
                aria-label={t('hosting.viewDetailAria', { number: pr.number })}
                onClick={() => void openDetail(pr.number)}
              >
                <ChevronRight size={14} />
              </Button>
            </li>
          ))}
        </ul>
      </article>

      <article className="structure-detail-card hosting-card">
        <div className="hosting-card-heading">
          <h3>
            <Plus size={15} />
            {t('hosting.create')} {noun}
          </h3>
        </div>
        <p className="hosting-card-hint">
          {t('hosting.createSourceHint')}{currentBranch ? `（${currentBranch}）` : ''}{t('hosting.createTargetHint')}
        </p>
        <form className="hosting-form" onSubmit={(event) => void submitCreate(event)}>
          <label className="hosting-field hosting-field-wide">
            <span>{t('hosting.titleLabel')} {noun}</span>
            <input
              value={form.title}
              maxLength={256}
              disabled={disabled || !tokenReady}
              placeholder={t('hosting.titleLabelNoun', { noun })}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label className="hosting-field hosting-field-wide">
            <span>{t('hosting.description')}</span>
            <textarea
              rows={4}
              value={form.body}
              disabled={disabled || !tokenReady}
              placeholder={t('hosting.bodyPlaceholder')}
              onChange={(event) => setForm({ ...form, body: event.target.value })}
            />
          </label>
          <label className="hosting-field">
            <span>{t('hosting.sourceBranchLabel')}</span>
            <input
              value={form.sourceBranch}
              spellCheck={false}
              disabled={disabled || !tokenReady}
              placeholder="feature/my-change"
              onChange={(event) => setForm({ ...form, sourceBranch: event.target.value })}
            />
          </label>
          <label className="hosting-field">
            <span>{t('hosting.targetBranchLabel')}</span>
            <input
              value={form.targetBranch}
              spellCheck={false}
              disabled={disabled || !tokenReady}
              placeholder="main"
              onChange={(event) => setForm({ ...form, targetBranch: event.target.value })}
            />
          </label>
          {effectiveProvider === 'github' && (
            <label className="hosting-check">
              <input
                type="checkbox"
                checked={form.draft}
                disabled={disabled || !tokenReady}
                onChange={(event) => setForm({ ...form, draft: event.target.checked })}
              />
              {t('hosting.createAsDraft')}
            </label>
          )}
          <div className="hosting-actions hosting-field-wide">
            <Button
              variant="primary"
              type="submit"
              disabled={disabled || !tokenReady || !repository}
            >
              <Check size={14} />
              {busy === 'create' ? t('hosting.creating') : t('hosting.createNoun', { noun })}
            </Button>
            {!repository && <span className="hosting-hint">{t('hosting.originRequired')}</span>}
          </div>
        </form>
      </article>
    </section>
  )
}
