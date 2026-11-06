import { describe, expect, it } from 'vitest'
import {
  RSA_BITS,
  SIMPLE_CREDENTIAL_HELPERS,
  buildCacheHelper,
  credentialHelperRisk,
  formatFingerprint,
  sshKeyBitsLabel,
  sshKeyTypeLabel,
  validateCredentialHelper,
  validateSshKeyForm,
} from './credentialsModel'

describe('credential helper allowlist', () => {
  it('accepts every fixed helper and the empty reset value', () => {
    expect(validateCredentialHelper('')).toEqual({ ok: true, value: '' })
    for (const helper of SIMPLE_CREDENTIAL_HELPERS) {
      expect(validateCredentialHelper(helper)).toEqual({ ok: true, value: helper })
    }
  })

  it('normalizes whitespace around cache timeouts and keeps 1-5 digits', () => {
    expect(validateCredentialHelper('  cache   --timeout=3600  ')).toEqual({
      ok: true,
      value: 'cache --timeout=3600',
    })
    expect(validateCredentialHelper(buildCacheHelper('60'))).toEqual({ ok: true, value: 'cache --timeout=60' })
    expect(validateCredentialHelper(buildCacheHelper(0))).toEqual({ ok: true, value: 'cache --timeout=0' })
  })

  it('rejects shell payloads, unknown helpers and malformed timeouts', () => {
    for (const rejected of [
      '!sh',
      'store; rm -rf /',
      'manager && echo x',
      'cache --timeout=123456',
      'cache --timeout=abc',
      'cache --timeout=',
      'cache --timeout=12 34',
      'osxkeychain --foo',
      'wincred\nextra',
      'unknown',
    ]) {
      expect(validateCredentialHelper(rejected).ok, rejected).toBe(false)
    }
  })

  it('flags plaintext and in-memory helpers', () => {
    expect(credentialHelperRisk('store')).toContain('明文')
    expect(credentialHelperRisk('cache --timeout=300')).toContain('内存')
    expect(credentialHelperRisk('osxkeychain')).toBeNull()
    expect(credentialHelperRisk('')).toBeNull()
  })
})

describe('fingerprint display', () => {
  it('keeps short fingerprints unchanged', () => {
    expect(formatFingerprint('SHA256:abc')).toBe('SHA256:abc')
    expect(formatFingerprint('')).toBe('—')
    expect(formatFingerprint(null)).toBe('—')
  })

  it('preserves the algorithm prefix and truncates long hashes with an ellipsis', () => {
    const full = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
    const shown = formatFingerprint(full)
    expect(shown.startsWith('SHA256:abcdefghij')).toBe(true)
    expect(shown).toContain('…')
    expect(shown.length).toBeLessThan(full.length)
    expect(shown.endsWith('DEFG')).toBe(true)
  })
})

describe('ssh key form validation', () => {
  const base = { fileName: 'id_ed25519', keyType: 'ed25519' as const, bits: '3072', comment: 'work', overwrite: false }

  it('accepts ed25519 and ignores its bits field', () => {
    const result = validateSshKeyForm({ ...base, bits: 'nonsense' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.values).toEqual({
        fileName: 'id_ed25519',
        keyType: 'ed25519',
        bits: null,
        comment: 'work',
        overwrite: false,
      })
    }
  })

  it('accepts only the three RSA sizes and defaults to 3072', () => {
    for (const bits of RSA_BITS) {
      const result = validateSshKeyForm({ ...base, keyType: 'rsa', bits })
      expect(result.ok, bits).toBe(true)
      if (result.ok) expect(result.values.bits).toBe(Number(bits))
    }
    expect(validateSshKeyForm({ ...base, keyType: 'rsa', bits: '1024' }).ok).toBe(false)
    const defaulted = validateSshKeyForm({ ...base, keyType: 'rsa', bits: '   ' })
    expect(defaulted.ok).toBe(true)
    if (defaulted.ok) expect(defaulted.values.bits).toBe(3072)
  })

  it('rejects unsafe file names and comments', () => {
    for (const fileName of ['', '-key', '../key', 'a/b', '.', '..', 'id_ed25519.pub', 'a'.repeat(65), 'ключ']) {
      expect(validateSshKeyForm({ ...base, fileName }).ok, fileName).toBe(false)
    }
    expect(validateSshKeyForm({ ...base, comment: 'line\nbreak' }).ok).toBe(false)
    expect(validateSshKeyForm({ ...base, comment: 'x'.repeat(201) }).ok).toBe(false)
  })

  it('renders key type and bit labels', () => {
    expect(sshKeyTypeLabel('ED25519')).toBe('Ed25519')
    expect(sshKeyTypeLabel('RSA')).toBe('RSA')
    expect(sshKeyTypeLabel('')).toBe('未知')
    expect(sshKeyBitsLabel(256)).toBe('256 位')
    expect(sshKeyBitsLabel(null)).toBe('—')
  })
})
