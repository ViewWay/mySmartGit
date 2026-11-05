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
export function confirmationMessage(report: RemoteOperationReport): string {
  const lines = [report.summary]
  lines.push(...(report.warnings ?? []).map((warning) => `· ${warning}`))
  const affected = (report.affected ?? []).slice(0, 12)
  if (affected.length) lines.push(`受影响：${affected.join('、')}${(report.affected?.length ?? 0) > affected.length ? ' 等' : ''}`)
  return lines.join('\n')
}

export const CANCELLED_NOTICE = '已取消，仓库未发生改动'

/** 未单独配置 push 地址时，Git 沿用 fetch 地址，这里如实展示而不是伪造一条。 */
export function pushUrlText(remote: RepositoryRemoteDetail): string {
  if (remote.pushUrls.length) return remote.pushUrls.join(' / ')
  return `沿用 fetch：${fetchUrlText(remote)}`
}

export function fetchUrlText(remote: RepositoryRemoteDetail): string {
  return remote.fetchUrls.join(' / ') || '未配置 fetch 地址'
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

export function tagKindLabel(kind: RepositoryTagDetail['kind']): string {
  return kind === 'annotated' ? '注释标签' : '轻量标签'
}

/** 标签风险提示：轻量标签无法带说明、签名标签删除后无法再校验、孤立提交可能被 GC。 */
export function tagRiskText(tag: RepositoryTagDetail): string | null {
  if (tag.signed) return '签名标签：删除后本地无法再校验该签名'
  if (!tag.onBranch) return '指向的提交不在任何本地分支上，删除后可能被 GC 回收'
  if (tag.kind === 'lightweight') return '轻量标签：没有打标签人与说明，推送后信息量最少'
  return null
}

/** 标签列表过滤 + 排序（创建时间倒序由后端保证，这里只做名称匹配）。 */
export function filterTags(tags: RepositoryTagDetail[], query: string): RepositoryTagDetail[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return tags
  return tags.filter((tag) => tag.name.toLocaleLowerCase().includes(needle) || tag.subject.toLocaleLowerCase().includes(needle))
}

/** 凭据被脱敏时给用户的解释，避免误以为地址坏了。 */
export function credentialNotice(remote: RepositoryRemoteDetail): string | null {
  if (!remote.credentialsRedacted) return null
  return '该远程的 URL 内嵌了凭据，展示时已替换为 [redacted]；建议改用凭据管理器或 SSH'
}
