// Force-with-lease 是危险操作：前端必须二次确认，绝不静默强推。
// 确认方式：手动输入当前分支名，完全一致才允许提交，防止误点。
type Translate = (key: string, params?: Record<string, string | number>) => string

export function canConfirmForcePush(typedBranch: string, branch: string): boolean {
  const trimmed = typedBranch.trim()
  return trimmed.length > 0 && trimmed === branch
}

export function forcePushLeaseNote(t: Translate): string {
  return t('repository.forcePush.leaseNote')
}
