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
        if (active) setSettingsError(describeAiError(error))
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
      onNotice?.('请先打开本地仓库')
      return
    }
    setBusy(true)
    setResult(null)
    setConfirmOverwrite(false)
    try {
      const options = normalizeAiOptions({ language, style, includeBody, maxSubjectChars })
      const generated = await generateCommitMessage(repositoryPath, options)
      setResult(generated)
      const notice = generatedMessageNotice(generated)
      if (notice) onNotice?.(notice)
    } catch (error) {
      onNotice?.(describeAiError(error))
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
      onNotice?.('AI 设置已保存')
    } catch (error) {
      setSettingsError(describeAiError(error))
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
      onNotice?.('已清除 AI API Key')
    } catch (error) {
      setSettingsError(describeAiError(error))
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
    onNotice?.('AI 提交信息已应用到提交框')
  }

  const configured = settings?.apiKeyConfigured === true

  return <section className="ai-assistant" aria-label="AI 提交消息助手">
    <div className="ai-assistant-head">
      <div className="ai-assistant-title">
        <Sparkles size={14}/>
        <strong>AI 提交助手</strong>
        <span className={`ai-assistant-badge${configured ? ' ready' : ''}`}>{configured ? '已配置' : '未配置 Key'}</span>
      </div>
      <button type="button" className="ai-assistant-link" onClick={() => setSettingsOpen((value) => !value)} aria-expanded={settingsOpen}>
        <Settings2 size={13}/> {settingsOpen ? '收起设置' : '服务设置'}
      </button>
    </div>

    {settingsOpen && <div className="ai-assistant-settings">
      <label>服务地址
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false}/>
      </label>
      <label>模型
        <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" spellCheck={false}/>
      </label>
      <label>API Key
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={configured ? '已保存，留空则保持不变' : '输入 API Key'}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="ai-assistant-settings-actions">
        <Button variant="secondary" size="compact" onClick={() => void persistSettings()} disabled={saving}>{saving ? '保存中…' : '保存设置'}</Button>
        <Button variant="danger" size="compact" onClick={() => void removeApiKey()} disabled={saving || !configured}>清除 Key</Button>
      </div>
      <p className="ai-assistant-hint">Key 仅保存在本机后端配置文件（Unix 权限 600），不会写入 Git 配置或提交。</p>
    </div>}

    {settingsError && <p className="ai-assistant-error" role="alert">{settingsError}</p>}

    <div className="ai-assistant-options">
      <label>语言
        <select value={language} onChange={(event) => setLanguage(event.target.value as AiLanguage)} aria-label="生成语言">
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>风格
        <select value={style} onChange={(event) => setStyle(event.target.value as AiMessageStyle)} aria-label="提交消息风格">
          <option value="conventional">规范（type: summary）</option>
          <option value="plain">普通</option>
        </select>
      </label>
      <label className="ai-assistant-check">
        <input type="checkbox" checked={includeBody} onChange={(event) => setIncludeBody(event.target.checked)}/> 含正文
      </label>
      <label>标题上限
        <input
          type="number"
          min={AI_SUBJECT_MIN_CHARS}
          max={AI_SUBJECT_MAX_CHARS}
          value={maxSubjectChars}
          onChange={(event) => setMaxSubjectChars(Number(event.target.value))}
          aria-label="subject 字符上限"
        />
      </label>
      <Button variant="secondary" size="compact" className="ai-assistant-generate" onClick={() => void generate()} disabled={busy || !repositoryPath}>
        {busy ? <Loader2 size={14}/> : <Sparkles size={14}/>} {busy ? '生成中…' : '生成提交信息'}
      </Button>
    </div>

    {!configured && !settingsOpen && <p className="ai-assistant-hint">尚未配置 API Key，请先在“服务设置”中保存。</p>}

    {result && <div className="ai-assistant-result">
      <div className="ai-assistant-result-meta">
        <span>{result.model}</span>
        {result.truncated && <span className="ai-assistant-truncated">已截断</span>}
      </div>
      <pre>{composeGeneratedMessage(result)}</pre>
      {result.note && <p className="ai-assistant-note">{result.note}</p>}
      {confirmOverwrite && <p className="ai-assistant-confirm">提交框已有内容，确认用 AI 生成结果覆盖当前草稿？</p>}
      <div className="ai-assistant-actions">
        {confirmOverwrite && <Button variant="secondary" size="compact" onClick={() => setConfirmOverwrite(false)}>取消</Button>}
        <Button variant="primary" size="compact" onClick={apply}>{confirmOverwrite ? '确认覆盖' : '应用到提交框'}</Button>
      </div>
    </div>}
  </section>
}
