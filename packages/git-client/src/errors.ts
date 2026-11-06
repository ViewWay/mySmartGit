export interface CommandErrorPayload {
  code?: unknown
  params?: unknown
  detail?: unknown
}

export class BranchlineCommandError extends Error {
  readonly code: string
  readonly params: Record<string, string>
  readonly detail?: string

  constructor(code: string, params: Record<string, string> = {}, detail?: string) {
    super(detail || code)
    this.name = 'BranchlineCommandError'
    this.code = code
    this.params = params
    this.detail = detail
  }

  static from(error: unknown): BranchlineCommandError {
    if (error instanceof BranchlineCommandError) return error
    if (typeof error === 'object' && error !== null && typeof (error as CommandErrorPayload).code === 'string') {
      const payload = error as CommandErrorPayload
      const params =
        typeof payload.params === 'object' && payload.params !== null
          ? Object.fromEntries(
              Object.entries(payload.params as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
            )
          : {}
      return new BranchlineCommandError(
        payload.code as string,
        params,
        typeof payload.detail === 'string' ? payload.detail : undefined,
      )
    }
    return new BranchlineCommandError('errors.unknown', {}, error instanceof Error ? error.message : String(error))
  }
}
