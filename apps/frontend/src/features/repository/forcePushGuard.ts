// Force-with-lease 是危险操作：前端必须二次确认，绝不静默强推。
// 确认方式：手动输入当前分支名，完全一致才允许提交，防止误点。
export function canConfirmForcePush(typedBranch: string, branch: string): boolean {
  const trimmed = typedBranch.trim()
  return trimmed.length > 0 && trimmed === branch
}

export const FORCE_PUSH_LEASE_NOTE =
  '使用 --force-with-lease：若远端分支自上次 Fetch 后又被他人推进，Git 会拒绝本次强推，避免覆盖协作者提交。'
