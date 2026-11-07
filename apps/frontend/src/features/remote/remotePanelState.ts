import type { RemoteOperationReport, RepositoryRemoteDetail, RepositoryTagDetail } from '../../repository'

/**
 * 远程与标签面板的纯逻辑：把「预览 → 二次确认 → 执行」的判定和展示文案集中在这里，
 * 组件只负责装配，方便单测覆盖安全边界。
 */

/** 后端明确没动手、等待用户确认。 */
export function needsConfirmation(report: RemoteOperationReport): boolean {
  return report.executed === false && report.requiresConfirmation === true
}

/** 后端报了成功但没有任何改动 —— 视为异常，不能当成成功播报。 */
export function isSilentNoop(report: RemoteOperationReport): boolean {
  return report.executed === false && report.requiresConfirmation === false
}

/** 确认框文案：摘要 + 警告 + 受影响对象，破坏性影响必须在确认前读得到。 */
export function confirmationMessage(report: RemoteOperationReport, t: Translate): string {
  const lines = [report.summary]
  lines.push(...(report.warnings ?? []).map((warning) => `· ${warning}`))
  const affected = (report.affected ?? []).slice(0, 12)
  if (affected.length) lines.push(t('repository.report.affected', { paths: affected.join('、'), truncated: (report.affected?.length ?? 0) > affected.length ? t('repository.tag.reportSuffix') : '' }))
  return lines.join('\n')
}

type Translate = (key: string, params?: Record<string, string | number>) => string

export function cancelledNotice(t: Translate): string {
  return t('repository.tag.cancelledNotice')
}

/** 未单独配置 push 地址时，Git 沿用 fetch 地址，这里如实展示而不是伪造一条。 */
export function pushUrlText(remote: RepositoryRemoteDetail, t: Translate): string {
  if (remote.pushUrls.length) return remote.pushUrls.join(' / ')
  return t('repository.tag.pushFollowsFetch', { url: fetchUrlText(remote, t) })
}

export function fetchUrlText(remote: RepositoryRemoteDetail, t: Translate): string {
  return remote.fetchUrls.join(' / ') || t('repository.tag.noFetchUrl')
}

/** 可作上游的远端分支：必须带远程前缀，且排除 refs/remotes/<远程>/HEAD。 */
export function upstreamCandidates(remoteBranches: string[]): string[] {
  return [...remoteBranches]
    .filter((reference) => reference.includes('/') && !reference.endsWith('/HEAD'))
    .sort((left, right) => left.localeCompare(right))
}

/** 把 `origin/main` 拆成远程名与分支名；不合法返回 null，交由后端二次校验。 */
export function splitUpstream(value: string | null | undefined): { remote: string; branch: string } | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed || trimmed.startsWith('-')) return null
  const separator = trimmed.indexOf('/')
  if (separator <= 0 || separator === trimmed.length - 1) return null
  return { remote: trimmed.slice(0, separator), branch: trimmed.slice(separator + 1) }
}

export function tagKindLabel(kind: RepositoryTagDetail['kind'], t: Translate): string {
  return t(kind === 'annotated' ? 'repository.tag.kindAnnotated' : 'repository.tag.kindLightweight')
}

/** 标签风险提示：轻量标签无法带说明、签名标签删除后无法再校验、孤立提交可能被 GC。 */
export function tagRiskText(tag: RepositoryTagDetail, t: Translate): string | null {
  if (tag.signed) return t('repository.tag.signedDeleteWarning')
  if (!tag.onBranch) return t('repository.tag.unreachableWarning')
  if (tag.kind === 'lightweight') return t('repository.tag.lightweightWarning')
  return null
}

/** 标签列表过滤 + 排序（创建时间倒序由后端保证，这里只做名称匹配）。 */
export function filterTags(tags: RepositoryTagDetail[], query: string): RepositoryTagDetail[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return tags
  return tags.filter((tag) => tag.name.toLocaleLowerCase().includes(needle) || tag.subject.toLocaleLowerCase().includes(needle))
}

/** 凭据被脱敏时给用户的解释，避免误以为地址坏了。 */
export function credentialNotice(remote: RepositoryRemoteDetail, t: Translate): string | null {
  if (!remote.credentialsRedacted) return null
  return t('repository.tag.redactedWarning')
}
