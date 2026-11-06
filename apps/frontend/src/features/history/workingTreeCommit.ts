import type { RepositoryFile, RepositoryOperationState, RepositorySnapshot } from '../../repository'

type Translate = (key: string, params?: Record<string, string | number>) => string

export const WORKING_TREE_COMMIT_ID = '__branchline_working_tree__'

export type WorkingTreeCommit = {
  id: string
  lane: number
  color: string
  title: string
  message: string
  author: string
  avatar: string
  time: string
  status: 'working'
  parent?: string
  files: number
  additions: number
  deletions: number
}

type WorkingTreeRepository = Pick<RepositorySnapshot, 'path' | 'branch' | 'commits' | 'worktrees'>

function comparablePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
}

export function resolveWorkingTreeParent(repository: WorkingTreeRepository) {
  const currentWorktree = repository.worktrees.find((worktree) => worktree.branch === repository.branch)
    ?? repository.worktrees.find((worktree) => comparablePath(worktree.path) === comparablePath(repository.path))
  return currentWorktree?.head
    ?? repository.commits.find((commit) => commit.branches?.includes(repository.branch))?.fullHash
}

export function createWorkingTreeCommit(files: RepositoryFile[], headHash?: string, operation?: RepositoryOperationState, t?: Translate): WorkingTreeCommit | null {
  const translate = t ?? ((key: string) => key)
  if (!files.length && !operation) return null
  const title = operation
    ? `${operation.label}：${operation.conflicts.length ? translate('history.working.conflict') : translate('history.working.pending')}`
    : translate('history.working.title')
  const author = operation ? translate('history.working.operation') : translate('history.working.tree')
  return {
    id: WORKING_TREE_COMMIT_ID,
    lane: 0,
    color: '#faad14',
    title,
    message: operation
      ? translate('history.working.operationInProgress', { label: operation.label })
      : translate('history.working.filesPending', { count: files.length }),
    author,
    avatar: operation ? 'OP' : 'WT',
    time: new Date().toISOString(),
    status: 'working',
    parent: headHash,
    files: files.length,
    additions: files.reduce((total, file) => total + file.add, 0),
    deletions: files.reduce((total, file) => total + file.del, 0),
  }
}
