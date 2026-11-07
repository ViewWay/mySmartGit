import { useI18n } from '../../i18n'
import { useEffect, useState } from 'react'
import { Loader2, Settings2, Sparkles } from 'lucide-react'
import { Button } from '../../components/Button'
import {
  clearAiApiKey,
  generateCommitMessage,
  loadAiSettings,
  saveAiSettings,
  type AiCommitMessage,
  type AiLanguage,
  type AiMessageStyle,
  type AiSettings,
} from '../../repository'
import {
  AI_SUBJECT_DEFAULT_CHARS,
  AI_SUBJECT_MAX_CHARS,
  AI_SUBJECT_MIN_CHARS,
  applyGeneratedDraft,
  composeGeneratedMessage,
  describeAiError,
  generatedMessageNotice,
  normalizeAiOptions,
} from './aiMessage'

export type CommitMessageAssistantProps = {
  repositoryPath: string
  currentMessage: string
  onApply: (message: string) => void
  onNotice?: (message: string) => void
}

/**
 * AI 提交消息助手：
 * - 语言/风格/是否含正文/标题上限可调；
 * - 生成结果先预览，提交框已有草稿时必须用户再次确认才覆盖；
 * - note / truncated 显式展示，不静默截断；
 * - API Key 只提交给后端保存，界面永远不回显明文。
 */
export function CommitMessageAssistant({ repositoryPath, currentMessage, onApply, onNotice }: CommitMessageAssistantProps) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [language, setLanguage] = useState<AiLanguage>('zh')
  const [style, setStyle] = useState<AiMessageStyle>('conventional')
  const [includeBody, setIncludeBody] = useState(true)
  const [maxSubjectChars, setMaxSubjectChars] = useState(AI_SUBJECT_DEFAULT_CHARS)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<AiCommitMessage | null>(null)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)

  useEffect(() => {
    let active = true
    loadAiSettings()
      .then((loaded) => {
        if (!active) return
        setSettings(loaded)
        setBaseUrl(loaded.baseUrl)
        setModel(loaded.model)
        setLanguage(loaded.language)
        setStyle(loaded.style)
        setIncludeBody(loaded.includeBody)
        setMaxSubjectChars(loaded.maxSubjectChars)
      })
      .catch((error) => {
        if (active) setSettingsError(describeAiError(error, t))
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setResult(null)
    setConfirmOverwrite(false)
  }, [repositoryPath])

  const generate = async () => {
    if (!repositoryPath) {
      onNotice?.(t('ai.requiresRepository'))
      return
    }
    setBusy(true)
    setResult(null)
    setConfirmOverwrite(false)
    try {
      const options = normalizeAiOptions({ language, style, includeBody, maxSubjectChars })
      const generated = await generateCommitMessage(repositoryPath, options)
      setResult(generated)
      const notice = generatedMessageNotice(generated, t)
      if (notice) onNotice?.(notice)
    } catch (error) {
      onNotice?.(describeAiError(error, t))
    } finally {
      setBusy(false)
    }
  }

  const persistSettings = async () => {
    setSaving(true)
    setSettingsError(null)
    try {
      const options = normalizeAiOptions({ language, style, includeBody, maxSubjectChars })
      const saved = await saveAiSettings({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        language: options.language,
        style: options.style,
        includeBody: options.includeBody,
        maxSubjectChars: options.maxSubjectChars,
      }, apiKey.trim() ? apiKey.trim() : null)
      setSettings(saved)
      setApiKey('')
      setBaseUrl(saved.baseUrl)
      setModel(saved.model)
      onNotice?.(t('ai.settingsSaved'))
    } catch (error) {
      setSettingsError(describeAiError(error, t))
    } finally {
      setSaving(false)
    }
  }

  const removeApiKey = async () => {
    setSaving(true)
    setSettingsError(null)
    try {
      const saved = await clearAiApiKey()
      setSettings(saved)
      setApiKey('')
      onNotice?.(t('ai.keyCleared'))
    } catch (error) {
      setSettingsError(describeAiError(error, t))
    } finally {
      setSaving(false)
    }
  }

  const apply = () => {
    if (!result) return
    const decision = applyGeneratedDraft({
      currentMessage,
      generated: composeGeneratedMessage(result),
      confirmed: confirmOverwrite,
    })
    if (decision.requiresConfirmation) {
      setConfirmOverwrite(true)
      return
    }
    if (!decision.applied) return
    onApply(decision.message)
    setResult(null)
    setConfirmOverwrite(false)
    onNotice?.(t('ai.applied'))
  }

  const configured = settings?.apiKeyConfigured === true

  return <section className="ai-assistant" aria-label={t('ai.title')}>
    <div className="ai-assistant-head">
      <div className="ai-assistant-title">
        <Sparkles size={14}/>
        <strong>{t('ai.subtitle')}</strong>
        <span className={`ai-assistant-badge${configured ? ' ready' : ''}`}>{configured ? t('ai.configured') : t('ai.keyMissing')}</span>
      </div>
      <button type="button" className="ai-assistant-link" onClick={() => setSettingsOpen((value) => !value)} aria-expanded={settingsOpen}>
        <Settings2 size={13}/> {settingsOpen ? t('ai.collapseSettings') : t('ai.serviceSettings')}
      </button>
    </div>

    {settingsOpen && <div className="ai-assistant-settings">
      <label>{t('ai.baseUrl')}
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false}/>
      </label>
      <label>{t('ai.model')}
        <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" spellCheck={false}/>
      </label>
      <label>API Key
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={configured ? t('ai.savedKeepHint') : t('ai.apiKeyPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="ai-assistant-settings-actions">
        <Button variant="secondary" size="compact" onClick={() => void persistSettings()} disabled={saving}>{saving ? t('ai.saving') : t('ai.saveSettings')}</Button>
        <Button variant="danger" size="compact" onClick={() => void removeApiKey()} disabled={saving || !configured}>{t('ai.clearKey')}</Button>
      </div>
      <p className="ai-assistant-hint">{t('ai.keyStorageNote')}</p>
    </div>}

    {settingsError && <p className="ai-assistant-error" role="alert">{settingsError}</p>}

    <div className="ai-assistant-options">
      <label>{t('ai.languageLabel')}
        <select value={language} onChange={(event) => setLanguage(event.target.value as AiLanguage)} aria-label={t('ai.languageSetting')}>
          <option value="zh">{t('ai.langZh')}</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>{t('ai.styleLabel')}
        <select value={style} onChange={(event) => setStyle(event.target.value as AiMessageStyle)} aria-label={t('ai.styleSetting')}>
          <option value="conventional">{t('ai.styleConventional')}</option>
          <option value="plain">{t('ai.stylePlain')}</option>
        </select>
      </label>
      <label className="ai-assistant-check">
        <input type="checkbox" checked={includeBody} onChange={(event) => setIncludeBody(event.target.checked)}/> {t('ai.styleWithBody')}
      </label>
      <label>{t('ai.subjectLimitLabel')}
        <input
          type="number"
          min={AI_SUBJECT_MIN_CHARS}
          max={AI_SUBJECT_MAX_CHARS}
          value={maxSubjectChars}
          onChange={(event) => setMaxSubjectChars(Number(event.target.value))}
          aria-label={t('ai.subjectLimitHint')}
        />
      </label>
      <Button variant="secondary" size="compact" className="ai-assistant-generate" onClick={() => void generate()} disabled={busy || !repositoryPath}>
        {busy ? <Loader2 size={14}/> : <Sparkles size={14}/>} {busy ? t('ai.generating') : t('ai.generate')}
      </Button>
    </div>

    {!configured && !settingsOpen && <p className="ai-assistant-hint">{t('ai.keyRequiredNotice')}</p>}

    {result && <div className="ai-assistant-result">
      <div className="ai-assistant-result-meta">
        <span>{result.model}</span>
        {result.truncated && <span className="ai-assistant-truncated">{t('ai.truncatedBadge')}</span>}
      </div>
      <pre>{composeGeneratedMessage(result)}</pre>
      {result.note && <p className="ai-assistant-note">{result.note}</p>}
      {confirmOverwrite && <p className="ai-assistant-confirm">{t('ai.overwriteConfirmMessage')}</p>}
      <div className="ai-assistant-actions">
        {confirmOverwrite && <Button variant="secondary" size="compact" onClick={() => setConfirmOverwrite(false)}>{t('common.cancel')}</Button>}
        <Button variant="primary" size="compact" onClick={apply}>{confirmOverwrite ? t('ai.confirmOverwrite') : t('ai.applyToDraft')}</Button>
      </div>
    </div>}
  </section>
}
