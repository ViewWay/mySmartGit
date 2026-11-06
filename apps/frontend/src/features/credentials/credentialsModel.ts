/**
 * 凭据与 SSH 设置的纯逻辑：白名单校验、指纹展示、密钥表单校验。
 *
 * 这些规则必须与后端 git_credentials.rs 保持一致：前端只做即时反馈，
 * 真正决定「能不能写进配置 / 能不能发起子进程」的仍是 Rust 侧校验。
 */

export type CredentialScope = 'global' | 'local'

export type SshKeyType = 'ed25519' | 'rsa'

export type CredentialHelperValidation =
  | { ok: true; value: string }
  | { ok: false; error: string }

export type SshKeyFormInput = {
  fileName: string
  keyType: SshKeyType
  /** 表单里是字符串；ed25519 时忽略，rsa 时只允许 2048 / 3072 / 4096。 */
  bits: string
  comment: string
  overwrite: boolean
}

export type SshKeyFormValues = {
  fileName: string
  keyType: SshKeyType
  bits: number | null
  comment: string | null
  overwrite: boolean
}

export type SshKeyFormValidation =
  | { ok: true; values: SshKeyFormValues }
  | { ok: false; error: string }

/** 固定助手名（与后端 SIMPLE_HELPERS 一致）。 */
export const SIMPLE_CREDENTIAL_HELPERS = [
  'osxkeychain',
  'manager',
  'manager-core',
  'libsecret',
  'wincred',
  'store',
  'cache',
] as const

export const RSA_BITS = ['2048', '3072', '4096'] as const

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 校验 credential.helper。Git 会通过 shell 执行该值，因此只接受固定白名单：
 * 空串（清除）、内置助手名、以及 `cache --timeout=<1-5 位数字>`。
 */
export function validateCredentialHelper(input: string): CredentialHelperValidation {
  const trimmed = input.trim()
  if (!trimmed) return { ok: true, value: '' }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, error: '凭据助手不能包含控制字符或换行' }
  }
  const normalized = trimmed.split(/\s+/).join(' ')
  if ((SIMPLE_CREDENTIAL_HELPERS as readonly string[]).includes(normalized)) {
    return { ok: true, value: normalized }
  }
  const cacheMatch = /^cache --timeout=(\d{1,5})$/.exec(normalized)
  if (cacheMatch) return { ok: true, value: normalized }
  return {
    ok: false,
    error: '只支持 osxkeychain、manager、manager-core、libsecret、wincred、store、cache 或 cache --timeout=<1-5 位秒数>',
  }
}

/** 风险提示：store 明文落盘；cache 仅内存。 */
export function credentialHelperRisk(helper: string): string | null {
  const normalized = helper.trim().split(/\s+/).join(' ')
  if (normalized === 'store') {
    return 'store 会把凭据以明文写入 ~/.git-credentials，其他程序可以直接读取；请仅在受控环境中使用。'
  }
  if (normalized === 'cache' || normalized.startsWith('cache --timeout=')) {
    return 'cache 只在内存中临时缓存凭据，Git 进程结束后失效。'
  }
  return null
}

/** 生成 `cache --timeout=N`；超时秒数必须是 1-5 位数字。 */
export function buildCacheHelper(seconds: string | number): string {
  return `cache --timeout=${String(seconds).trim()}`
}

/** 指纹展示：保留算法前缀，长指纹中间省略，短指纹原样返回。 */
export function formatFingerprint(fingerprint: string | null | undefined, maxLength = 42): string {
  const value = fingerprint?.trim()
  if (!value) return '—'
  if (value.length <= maxLength) return value
  const separator = value.indexOf(':')
  const prefix = separator > 0 && separator <= 8 ? value.slice(0, separator + 1) : ''
  const body = value.slice(prefix.length)
  const headLength = Math.max(8, Math.min(16, maxLength - prefix.length - 8))
  const tailLength = Math.max(4, Math.min(8, maxLength - prefix.length - headLength - 1))
  return `${prefix}${body.slice(0, headLength)}…${body.slice(-tailLength)}`
}

export function sshKeyTypeLabel(keyType: string): string {
  switch (keyType.trim().toUpperCase()) {
    case 'ED25519':
      return 'Ed25519'
    case 'ED25519-SK':
      return 'Ed25519-SK'
    case 'RSA':
      return 'RSA'
    case 'ECDSA':
      return 'ECDSA'
    case 'ECDSA-SK':
      return 'ECDSA-SK'
    case 'DSA':
      return 'DSA'
    default:
      return '未知'
  }
}

export function sshKeyBitsLabel(bits: number | null | undefined): string {
  return typeof bits === 'number' && Number.isFinite(bits) ? `${bits} 位` : '—'
}

/**
 * 校验生成密钥表单。规则与后端一致：
 * 文件名 `[A-Za-z0-9._-]{1,64}`、不能以 `-` 开头、不能带 .pub；
 * rsa 位数仅 2048/3072/4096；ed25519 忽略位数；注释禁止控制字符。
 */
export function validateSshKeyForm(input: SshKeyFormInput): SshKeyFormValidation {
  const fileName = input.fileName.trim()
  if (!fileName) return { ok: false, error: '请输入密钥文件名' }
  if (!FILE_NAME_PATTERN.test(fileName)) {
    return { ok: false, error: '文件名只能包含字母、数字、点、下划线和短横线，且不超过 64 字符' }
  }
  if (fileName.startsWith('-')) {
    return { ok: false, error: '文件名不能以 - 开头，否则会被当成命令选项' }
  }
  if (fileName === '.' || fileName === '..') {
    return { ok: false, error: '文件名不能是 . 或 ..' }
  }
  if (fileName.endsWith('.pub')) {
    return { ok: false, error: '文件名不要带 .pub 后缀，公钥会自动生成' }
  }
  if (input.keyType !== 'ed25519' && input.keyType !== 'rsa') {
    return { ok: false, error: '密钥类型只能是 ed25519 或 rsa' }
  }

  let bits: number | null = null
  if (input.keyType === 'rsa') {
    const raw = input.bits.trim() || '3072'
    if (!(RSA_BITS as readonly string[]).includes(raw)) {
      return { ok: false, error: 'RSA 位数只能是 2048 / 3072 / 4096' }
    }
    bits = Number(raw)
  }

  const comment = input.comment.trim()
  if (comment.length > 200) {
    return { ok: false, error: '密钥注释过长（上限 200 字符）' }
  }
  if (CONTROL_CHARACTERS.test(comment)) {
    return { ok: false, error: '密钥注释不能包含控制字符或换行' }
  }

  return {
    ok: true,
    values: {
      fileName,
      keyType: input.keyType,
      bits,
      comment: comment || null,
      overwrite: input.overwrite,
    },
  }
}
