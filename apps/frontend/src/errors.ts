import { BranchlineCommandError } from '@branchline/git-client'

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface ErrorPresentation {
  message: string
  detail?: string
}

export function errorPresentation(error: unknown, t: Translate): ErrorPresentation {
  const normalized = BranchlineCommandError.from(error)
  const key = normalized.code.startsWith('errors.') ? normalized.code : `errors.${normalized.code}`
  const message = t(key, normalized.params)
  return {
    message: message === key ? t('errors.unknown') : message,
    detail: normalized.detail,
  }
}
