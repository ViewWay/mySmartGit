import type { SubmoduleCommitEntry, SubmodulePointerDiff } from '../../repository'

/**
 * 子模块指针差异的展示逻辑（W2-10，对标 EnjoyGit 的 Submodule 差异）。
 * 只负责「怎么讲清楚这次指针移动」，数据全部来自后端 load_submodule_pointer_diff。
 */

export type PointerChangeKind = 'unchanged' | 'staged' | 'unstaged' | 'both' | 'uninitialized' | 'unknown'

/** 指针处于什么状态：父仓库 HEAD / 索引 / 子模块工作区三者两两比较的结果。 */
export function pointerChangeKind(diff: SubmodulePointerDiff): PointerChangeKind {
  if (diff.uninitialized) return 'uninitialized'
  if (!diff.previousCommit || !diff.targetCommit) return 'unknown'
  if (!diff.changed) return 'unchanged'
  if (diff.pointerStaged && diff.pointerUnstaged) return 'both'
  if (diff.pointerStaged) return 'staged'
  if (diff.pointerUnstaged) return 'unstaged'
  return 'unknown'
}

type Translate = (key: string, params?: Record<string, string | number>) => string

const changeLabelKeys: Record<PointerChangeKind, string> = {
  unchanged: 'repository.submodule.pointerUnchanged',
  staged: 'repository.submodule.pointerStaged',
  unstaged: 'repository.submodule.pointerUnstaged',
  both: 'repository.submodule.pointerBoth',
  uninitialized: 'repository.submodule.pointerUninitialized',
  unknown: 'repository.submodule.pointerUnknown',
}

export function pointerChangeLabel(kind: PointerChangeKind, t: Translate): string {
  return t(changeLabelKeys[kind])
}

export function pointerChangeTone(kind: PointerChangeKind): 'neutral' | 'warning' | 'danger' {
  if (kind === 'unchanged') return 'neutral'
  if (kind === 'unknown' || kind === 'uninitialized') return 'warning'
  return 'danger'
}

/** 短哈希对：`旧 → 新`；缺一侧时用 em dash 占位，绝不伪造。 */
export function pointerHashPair(diff: SubmodulePointerDiff): { from: string; to: string } {
  const from = diff.previousCommit ? diff.previousCommit.slice(0, 8) : '—'
  const to = diff.targetCommit ? diff.targetCommit.slice(0, 8) : '—'
  return { from, to }
}

/** 提交列表的展示上限，超出时提示总数，避免面板被长历史撑爆。 */
export const COMMIT_DISPLAY_LIMIT = 30

export function cappedCommits(commits: SubmoduleCommitEntry[], limit = COMMIT_DISPLAY_LIMIT) {
  return {
    shown: commits.slice(0, limit),
    hidden: Math.max(commits.length - limit, 0),
  }
}

/**
 * 一句人话说明这次差异。
 * 后端的 summary 只讲指针；这里补上「是否非快进」「是否有本地改动」，
 * 因为这两件事用户最容易踩（回退指针会丢掉别人的提交）。
 */
export function describePointerDiff(diff: SubmodulePointerDiff, t: Translate): string[] {
  const lines = [diff.summary]
  const kind = pointerChangeKind(diff)
  if (kind !== 'unchanged' && kind !== 'uninitialized' && !diff.fastForward && diff.previousCommit && diff.targetCommit) {
    lines.push(t('repository.submodule.nonFastForward'))
  }
  if (diff.removedCount > 0) lines.push(t('repository.submodule.droppedCommits', { count: diff.removedCount }))
  if (diff.dirtyFiles > 0) lines.push(t('repository.submodule.dirtyFiles', { count: diff.dirtyFiles }))
  if (diff.detached && !diff.uninitialized) lines.push(t('repository.submodule.detachedHead'))
  return lines
}

/** 差异行的紧凑文本，供列表渲染复用。 */
export function commitLineText(commit: SubmoduleCommitEntry): string {
  return `${commit.shortHash} ${commit.title} · ${commit.author} · ${commit.commitTime}`
}
