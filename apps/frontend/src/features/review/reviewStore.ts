// 审查评论的 invoke 接缝：对 UI 只暴露可替换的 backend 接口，
// hook 测试用内存实现替换，桌面运行时走 @branchline/git-client。
import {
  deleteReviewThread,
  listReviewThreads,
  setReviewThreadResolved,
  upsertReviewThread,
} from '@branchline/git-client'
import type { ReviewThread } from '@branchline/git-models'

export interface ReviewBackend {
  list(repositoryPath: string): Promise<ReviewThread[]>
  upsert(repositoryPath: string, thread: ReviewThread): Promise<ReviewThread>
  remove(repositoryPath: string, threadId: string): Promise<void>
  resolve(repositoryPath: string, threadId: string, resolved: boolean): Promise<ReviewThread>
}

/** 桌面端实现：直接转发 B1 的四个命令封装。 */
export const desktopReviewBackend: ReviewBackend = {
  list: (repositoryPath) => listReviewThreads(repositoryPath),
  upsert: (repositoryPath, thread) => upsertReviewThread(repositoryPath, thread),
  remove: (repositoryPath, threadId) => deleteReviewThread(repositoryPath, threadId),
  resolve: (repositoryPath, threadId, resolved) => setReviewThreadResolved(repositoryPath, threadId, resolved),
}
