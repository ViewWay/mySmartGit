import { useMemo, useSyncExternalStore } from 'react'

export type Language = 'zh' | 'en'

type Dictionary = Record<string, string>

const MESSAGES: Record<Language, Dictionary> = {
  zh: {
    'language.switch': 'English',
    'language.title': '切换界面语言 / Switch language',
    'nav.repositories': '仓库管理',
    'nav.history': '提交图谱',
    'nav.changes': '暂存与提交',
    'nav.stash': 'Stash 管理',
    'nav.recovery': '恢复与定位',
    'nav.remotes': '远程管理',
    'nav.tags': '标签',
    'nav.lfs': 'Git LFS',
    'nav.gitflow': 'Gitflow 工作流',
    'nav.credentials': 'SSH 与凭据',
    'nav.hosting': '托管平台',
    'nav.terminal': '终端与命令',
    'nav.updates': '版本与更新',
    'nav.commandLog': '执行命令日志',
    'nav.gitConfig': '本地 Git 配置',
    'sidebar.emptyTitle': '尚未打开仓库',
    'sidebar.emptyHint': '打开本地 Git 仓库后，这里会显示分支、Worktree 和 Submodule。',
    'sidebar.opening': '正在打开…',
    'sidebar.open': '打开仓库',
    'tab.history': '提交图谱',
    'tab.changes': '暂存与提交',
    'tab.stash': 'Stash 管理',
    'tab.recovery': '恢复与定位',
    'tab.search': '深度搜索',
    'tab.tree': '文件树',
    'tab.historyEdit': '整理历史',
    'tab.compare': 'Diff 比较',
    'tab.merge': '合并队列',
    'common.refresh': '刷新',
    'common.close': '关闭',
    'common.collapseSidebar': '收起左侧面板',
    'common.expandSidebar': '展开左侧面板',
    'common.language': '切换界面语言',
    'updates.eyebrow': '交付',
    'updates.title': '版本与更新',
    'updates.current': '当前版本',
    'updates.check': '检查更新',
    'updates.checking': '正在检查…',
    'updates.latest': '已是最新版本',
    'updates.available': '发现新版本 {{version}}',
    'updates.releasedAt': '发布时间：{{date}}',
    'updates.notes': '更新说明',
    'updates.download': '下载并安装',
    'updates.downloading': '正在下载…',
    'updates.installing': '正在安装…',
    'updates.ready': '更新已安装，重启后生效',
    'updates.relaunch': '重启并应用',
    'updates.browser': '更新检查仅在桌面应用中可用。',
    'updates.error': '检查更新失败：{{message}}',
    'updates.errorTitle': '更新流程失败',
    'updates.progress': '已下载 {{done}} / {{total}}',
    'updates.channel': '更新源',
    'updates.channelHint': '发布通道固定为 GitHub Releases；安装包由 CI 签名后上传。',
    'updates.idle': '等待检查',
    'updates.readyHint': '重启应用即可完成切换，当前工作区会先保存状态。',
    'updates.signature': '安装包会校验签名，下载中断可重新检查后重试。',
    'updates.browserDetail': '当前是浏览器预览，无法访问本地更新器；请在打包后的桌面应用中检查更新。',
    'updates.retry': '重新检查',
  },
  en: {
    'language.switch': '中文',
    'language.title': 'Switch language / 切换界面语言',
    'nav.repositories': 'Repositories',
    'nav.history': 'Commit Graph',
    'nav.changes': 'Stage & Commit',
    'nav.stash': 'Stashes',
    'nav.recovery': 'Recovery',
    'nav.remotes': 'Remotes',
    'nav.tags': 'Tags',
    'nav.lfs': 'Git LFS',
    'nav.gitflow': 'Gitflow',
    'nav.credentials': 'SSH & Credentials',
    'nav.hosting': 'Hosting',
    'nav.terminal': 'Terminal & Commands',
    'nav.updates': 'Version & Updates',
    'nav.commandLog': 'Command log',
    'nav.gitConfig': 'Local Git config',
    'sidebar.emptyTitle': 'No repository open',
    'sidebar.emptyHint': 'Open a local Git repository to see branches, worktrees, and submodules here.',
    'sidebar.opening': 'Opening…',
    'sidebar.open': 'Open repository',
    'tab.history': 'Commit Graph',
    'tab.changes': 'Stage & Commit',
    'tab.stash': 'Stashes',
    'tab.recovery': 'Recovery',
    'tab.search': 'Deep Search',
    'tab.tree': 'File Tree',
    'tab.historyEdit': 'Edit History',
    'tab.compare': 'Compare',
    'tab.merge': 'Merge Queue',
    'common.refresh': 'Refresh',
    'common.close': 'Close',
    'common.collapseSidebar': 'Collapse sidebar',
    'common.expandSidebar': 'Expand sidebar',
    'common.language': 'Switch language',
    'updates.eyebrow': 'Delivery',
    'updates.title': 'Version & Updates',
    'updates.current': 'Current version',
    'updates.check': 'Check for updates',
    'updates.checking': 'Checking…',
    'updates.latest': 'You are up to date',
    'updates.available': 'Version {{version}} is available',
    'updates.releasedAt': 'Released {{date}}',
    'updates.notes': 'Release notes',
    'updates.download': 'Download & install',
    'updates.downloading': 'Downloading…',
    'updates.installing': 'Installing…',
    'updates.ready': 'Update installed, restart to apply',
    'updates.relaunch': 'Restart now',
    'updates.browser': 'Update checks are only available in the desktop app.',
    'updates.error': 'Update check failed: {{message}}',
    'updates.errorTitle': 'Update failed',
    'updates.progress': 'Downloaded {{done}} / {{total}}',
    'updates.channel': 'Channel',
    'updates.channelHint': 'Releases are served from GitHub Releases; installers are signed in CI.',
    'updates.idle': 'Not checked yet',
    'updates.readyHint': 'Restart to finish switching versions; the workspace state is saved first.',
    'updates.signature': 'Installers are signature-verified; retry the check if a download is interrupted.',
    'updates.browserDetail': 'This is a browser preview without the native updater. Check for updates in the packaged desktop app.',
    'updates.retry': 'Check again',
  },
}

const DEFAULT_LANGUAGE: Language = 'zh'
const STORAGE_KEY = 'branchline.language'
const listeners = new Set<() => void>()
let currentLanguage: Language = readStoredLanguage()

function normalizeLanguage(value: unknown): Language {
  return value === 'en' ? 'en' : 'zh'
}

function readStoredLanguage(): Language {
  try {
    if (typeof window === 'undefined') return DEFAULT_LANGUAGE
    return normalizeLanguage(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_LANGUAGE
  }
}

function applyDocumentLanguage(language: Language) {
  try {
    if (typeof document !== 'undefined') document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  } catch {
    // document may be unavailable in tests
  }
}

applyDocumentLanguage(currentLanguage)

export function getLanguage(): Language {
  return currentLanguage
}

export function setLanguage(language: Language) {
  const next = normalizeLanguage(language)
  if (next === currentLanguage) return
  currentLanguage = next
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // persistence is best-effort
  }
  applyDocumentLanguage(next)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function translate(language: Language, key: string, params?: Record<string, string | number>) {
  const template = MESSAGES[language][key] ?? MESSAGES[DEFAULT_LANGUAGE][key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

export function useI18n() {
  const language = useSyncExternalStore(subscribe, getLanguage, () => DEFAULT_LANGUAGE)
  return useMemo(
    () => ({
      language,
      setLanguage,
      locale: language === 'zh' ? 'zh-CN' : 'en-US',
      t: (key: string, params?: Record<string, string | number>) => translate(language, key, params),
    }),
    [language],
  )
}
