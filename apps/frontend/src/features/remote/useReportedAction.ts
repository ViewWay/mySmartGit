import { useCallback } from 'react'
import { translate, getLanguage } from '../../i18n'
import type { ConfirmDialogOptions } from '../../components/ConfirmDialog'
import type { RemoteOperationReport, RepositorySnapshot } from '../../repository'
import { cancelledNotice, confirmationMessage, isSilentNoop, needsConfirmation } from './remotePanelState'

export type ExecuteReportedActionResult = {
  /** 最终报告；用户在确认框取消时为 null（仓库一定没被改动）。 */
  report: RemoteOperationReport | null
  cancelled: boolean
  notices: string[]
}

/**
 * 纯逻辑版执行器（不依赖 React，便于单测覆盖安全边界）：
 * 1. 先以 confirm=false 取预览；
 * 2. 若后端标记 requiresConfirmation，把 summary/warnings/affected 展示给用户；
 * 3. 只有用户明确同意，才以 confirm=true 调第二次；
 * 4. 取消时绝不发起第二次调用，并播报「仓库未发生改动」。
 * `applySnapshot` / `notices` 让调用方决定如何落地副作用。
 */
const zhT = (key: string, params?: Record<string, string | number>) => translate(getLanguage(), key, params)

export async function executeReportedAction({
  action,
  confirm,
  title,
  done,
  applySnapshot,
  applyReport,
}: {
  action: (confirm: boolean) => Promise<RemoteOperationReport>
  confirm: (options: ConfirmDialogOptions | string) => Promise<boolean>
  title: string
  done: string
  applySnapshot: (snapshot: RepositorySnapshot) => void
  applyReport: (report: RemoteOperationReport) => void
}): Promise<ExecuteReportedActionResult> {
  const notices: string[] = []
  const finish = (report: RemoteOperationReport): ExecuteReportedActionResult => {
    // 快照只在真正执行后回填；预览轮次不允许改动主界面状态。
    if (report.snapshot) applySnapshot(report.snapshot)
    applyReport(report)
    notices.push(report.warnings.length ? `${done}（${report.warnings[0]}）` : done)
    return { report, cancelled: false, notices }
  }
  const preview = await action(false)
  if (needsConfirmation(preview)) {
    const accepted = await confirm({
      title: `确认${title}`,
      message: confirmationMessage(preview, zhT),
      confirmLabel: zhT('repository.report.confirm'),
      variant: 'danger',
    })
    if (!accepted) {
      notices.push(cancelledNotice(zhT))
      return { report: null, cancelled: true, notices }
    }
    return finish(await action(true))
  }
  if (isSilentNoop(preview)) {
    // 后端既没执行也没要求确认：属于异常状态，必须显式暴露而不是谎报成功。
    notices.push(`${title}未执行：${preview.summary}`)
    applyReport(preview)
    return { report: preview, cancelled: false, notices }
  }
  return finish(preview)
}

/** React 侧包装：把副作用接到快照与通知回调上。 */
export function useReportedAction({ confirm, onSnapshot, onNotice }: {
  confirm: (options: ConfirmDialogOptions | string) => Promise<boolean>
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}) {
  return useCallback(async (
    action: (confirm: boolean) => Promise<RemoteOperationReport>,
    title: string,
    done: string,
  ): Promise<RemoteOperationReport | null> => {
    try {
      const result = await executeReportedAction({
        action,
        confirm,
        title,
        done,
        applySnapshot: onSnapshot,
        applyReport: () => {},
      })
      result.notices.forEach(onNotice)
      return result.report
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [confirm, onNotice, onSnapshot])
}
