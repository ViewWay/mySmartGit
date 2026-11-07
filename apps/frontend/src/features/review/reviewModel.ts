// 审查评论纯逻辑：锚点键、归组、排序与乐观更新变换。
// 设计文档：docs/superpowers/specs/2026-11-07-code-review-design.md（B2）。
// 本文件不碰 React / invoke，全部可脱离后端单测。
import type { ReviewComment, ReviewThread, ReviewThreadSide } from '@branchline/git-models'

/** 锚点键：同 ref + 文件下唯一标识一行（side 区分新旧侧）。 */
export function reviewAnchorKey(filePath: string, line: number, side: ReviewThreadSide = 'new'): string {
  return `${filePath}#${side}:${line}`
}

export function threadAnchorKey(thread: Pick<ReviewThread, 'filePath' | 'line' | 'side'>): string {
  return reviewAnchorKey(thread.filePath, thread.line, thread.side)
}

/**
 * 过滤出锚定在 (reference, filePath) 过滤出线程，按行号 + 创建时间升序。
 * 线程锚在其他 ref 上时隐藏（数据仍在本地存储，切回 ref 后可见）。
 */
export function threadsForFile(threads: ReviewThread[], reference: string, filePath: string): ReviewThread[] {
  const matched = threads.filter((thread) => thread.reference === reference && thread.filePath === filePath)
  matched.sort((a, b) => a.line - b.line || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return matched
}

/** 有线程的行号集合（喂给 CodeMirror gutter）。 */
export function threadLineSet(threads: ReviewThread[]): Set<number> {
  return new Set(threads.map((thread) => thread.line))
}

/** 按 (行, 创建时间) 升序，把线程归组到行号。 */
export function groupThreadsByLine(threads: ReviewThread[]): Map<number, ReviewThread[]> {
  const groups = new Map<number, ReviewThread[]>()
  for (const thread of threads) {
    const bucket = groups.get(thread.line)
    if (bucket) bucket.push(thread)
    else groups.set(thread.line, [thread])
  }
  return groups
}

/**
 * uuid v4；环境缺 randomUUID 时退回 CSPRNG 随机字节。
 * 该 id 仅为本地线程/评论标识（非令牌、非加密材料），已按注释约定不用于安全用途。
 */
export function createReviewId(): string {
  const globalCrypto = typeof crypto !== 'undefined' ? crypto : undefined
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') return globalCrypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (globalCrypto?.getRandomValues) {
    globalCrypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 新建一条评论；createdAt 由后端规整，这里给乐观显示用的时间戳。 */
export function buildComment(author: string, body: string, now: string): ReviewComment {
  return { id: createReviewId(), author, body, createdAt: now }
}

/** 组装新建线程：本地时间戳仅用于乐观显示，后端 upsert 会统一规整。 */
export function buildThread(input: {
  filePath: string
  line: number
  side?: ReviewThreadSide
  author: string
  body: string
  now: string
}): ReviewThread {
  const comment = buildComment(input.author, input.body, input.now)
  return {
    id: createReviewId(),
    filePath: input.filePath,
    reference: '',
    line: input.line,
    side: input.side ?? 'new',
    resolved: false,
    createdAt: input.now,
    updatedAt: input.now,
    comments: [comment],
    remote: null,
  }
}

// ---------------------------------------------------------------------------
// 乐观更新变换：全部返回新数组，绝不原地修改。
// ---------------------------------------------------------------------------

/** 按 id 覆盖插入（乐观草稿与后端回执共用）。 */
export function withUpsertedThread(threads: ReviewThread[], thread: ReviewThread): ReviewThread[] {
  const index = threads.findIndex((item) => item.id === thread.id)
  if (index === -1) return [...threads, thread]
  const next = threads.slice()
  next[index] = thread
  return next
}

export function withRepliedComment(threads: ReviewThread[], threadId: string, comment: ReviewComment): ReviewThread[] {
  return threads.map((thread) =>
    thread.id === threadId ? { ...thread, comments: [...thread.comments, comment] } : thread,
  )
}

export function withResolved(threads: ReviewThread[], threadId: string, resolved: boolean): ReviewThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, resolved } : thread))
}

export function withoutThread(threads: ReviewThread[], threadId: string): ReviewThread[] {
  return threads.filter((thread) => thread.id !== threadId)
}
