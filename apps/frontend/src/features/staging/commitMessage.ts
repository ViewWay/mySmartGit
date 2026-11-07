import type { RepositoryOperationState } from '../../repository'

export function templateMessage(content: string) {
  return content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

export function initialCommitMessage(
  templateContent: string,
  operation?: Pick<RepositoryOperationState, 'kind' | 'message'>,
) {
  const content = operation?.kind === 'merge' && operation.message?.trim()
    ? operation.message
    : templateContent
  return templateMessage(content)
}

// 缺陷 1：提交等写操作结束后，草稿的处理规则。
// 只有操作成功（草稿已被消费/工作区刷新）才重新套用模板；失败时必须原样保留用户草稿，
// 不能用模板冲掉刚写下的提交信息。仓库/模板本身发生实质变化的重套用由 StagingPage 里
// 按 appliedTemplateKey 去重的 useEffect 负责，这里不重复实现。
export function draftAfterAction(input: {
  succeeded: boolean
  currentDraft: string
  templateContent: string
}) {
  return input.succeeded ? templateMessage(input.templateContent) : input.currentDraft
}

// 缺陷 2：提交按钮的可用性/文案。
// 纯 Amend（改提交信息）时 git commit --amend 允许零暂存文件，因此 amend 为真不应因
// 无暂存文件被禁用；非 amend 时维持原有「必须有暂存文件」的条件。
type Translate = (key: string, params?: Record<string, string | number>) => string

export function commitButtonState(input: { stagedCount: number; busy: boolean; amend: boolean }, t: Translate): { disabled: boolean; label: string } {
  const disabled = input.busy || (!input.amend && input.stagedCount === 0)
  let label: string
  if (input.busy) label = t('operation.commit.busy')
  else if (input.amend && input.stagedCount === 0) label = t('operation.commit.amendOnly')
  else label = t('operation.commit.files', { count: input.stagedCount })
  return { disabled, label }
}
