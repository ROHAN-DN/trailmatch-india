import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'crypto'
import {
  roleRequiresMFA, PRIVILEGED_ROLES,
  encryptSecret, decryptSecret,
  generateTOTPSecret, buildOtpAuthUri, verifyTOTPCode,
  generateBackupCodes, hashBackupCode, verifyBackupCode,
} from '../mfa'
import { generate as otpGenerate } from 'otplib'

beforeAll(() => {
  // A real, valid-shaped key for these tests — never a production secret,
  // this environment variable is set fresh in every test run.
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
})

describe('roleRequiresMFA', () => {
  it('requires MFA for owner and admin', () => {
    expect(roleRequiresMFA('owner')).toBe(true)
    expect(roleRequiresMFA('admin')).toBe(true)
  })

  it('does not require MFA for coordinator or viewer', () => {
    expect(roleRequiresMFA('coordinator')).toBe(false)
    expect(roleRequiresMFA('viewer')).toBe(false)
  })

  it('does not require MFA for an unrecognized or missing role — fails to "not required", not "required"', () => {
    // Deliberate: this function's callers gate access based on its
    // result, and this is a case where failing open (not blocking
    // access) is correct — an unrecognized role isn't a privileged one
    // by definition, and blocking every malformed session on an MFA
    // challenge it can never complete would be a real availability bug,
    // not extra security.
    expect(roleRequiresMFA(null)).toBe(false)
    expect(roleRequiresMFA(undefined)).toBe(false)
    expect(roleRequiresMFA('something-unexpected')).toBe(false)
  })

  it('PRIVILEGED_ROLES is exactly owner and admin — locks in the set this whole feature depends on', () => {
    expect(PRIVILEGED_ROLES).toEqual(['owner', 'admin'])
  })
})

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret correctly', () => {
    const secret = generateTOTPSecret()
    const encrypted = encryptSecret(secret)
    expect(decryptSecret(encrypted)).toBe(secret)
  })

  it('produces a different ciphertext each time (random IV) even for the same plaintext', () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const a = encryptSecret(secret)
    const b = encryptSecret(secret)
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe(secret)
    expect(decryptSecret(b)).toBe(secret)
  })

  it('is in iv:authTag:ciphertext hex format', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP')
    const parts = encrypted.split(':')
    expect(parts).toHaveLength(3)
    for (const p of parts) expect(p).toMatch(/^[0-9a-f]+$/)
  })

  it('throws (fails closed) on tampered ciphertext rather than returning garbage', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP')
    const [iv, authTag, data] = encrypted.split(':')
    const tampered = `${iv}:${authTag}:${data.slice(0, -2)}00` // flip the last byte
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('throws on a malformed (wrong-shape) encrypted string', () => {
    expect(() => decryptSecret('not-the-right-format')).toThrow('Malformed encrypted MFA secret')
  })

  it('throws clearly when MFA_ENCRYPTION_KEY is missing', () => {
    const saved = process.env.MFA_ENCRYPTION_KEY
    delete process.env.MFA_ENCRYPTION_KEY
    expect(() => encryptSecret('x')).toThrow('MFA_ENCRYPTION_KEY environment variable is not set')
    process.env.MFA_ENCRYPTION_KEY = saved
  })

  it('throws clearly when MFA_ENCRYPTION_KEY is the wrong length', () => {
    const saved = process.env.MFA_ENCRYPTION_KEY
    process.env.MFA_ENCRYPTION_KEY = 'tooshort'
    expect(() => encryptSecret('x')).toThrow('must decode to exactly 32 bytes')
    process.env.MFA_ENCRYPTION_KEY = saved
  })
})

describe('TOTP generation and URI building', () => {
  it('generates a base32-shaped secret', () => {
    const secret = generateTOTPSecret()
    expect(secret).toMatch(/^[A-Z2-7]+$/)
    expect(secret.length).toBeGreaterThanOrEqual(16)
  })

  it('generates a different secret each call', () => {
    expect(generateTOTPSecret()).not.toBe(generateTOTPSecret())
  })

  it('builds a valid otpauth:// URI containing the issuer and account email', () => {
    const uri = buildOtpAuthUri('JBSWY3DPEHPK3PXP', 'coordinator@testhospital.in')
    expect(uri).toMatch(/^otpauth:\/\/totp\//)
    expect(uri).toContain('TrialMatch')
    expect(decodeURIComponent(uri)).toContain('coordinator@testhospital.in')
  })
})

describe('verifyTOTPCode — against real generated codes, not mocked', () => {
  it('accepts a genuinely valid, freshly generated code', async () => {
    const secret = generateTOTPSecret()
    const code = await otpGenerate({ secret })
    const result = await verifyTOTPCode(secret, code)
    expect(result.valid).toBe(true)
    expect(typeof result.timeStep).toBe('number')
  })

  it('rejects a wrong code', async () => {
    const secret = generateTOTPSecret()
    const realCode = await otpGenerate({ secret })
    const wrongCode = realCode === '000000' ? '111111' : '000000'
    const result = await verifyTOTPCode(secret, wrongCode)
    expect(result.valid).toBe(false)
  })

  it('rejects a code for the wrong secret', async () => {
    const secretA = generateTOTPSecret()
    const secretB = generateTOTPSecret()
    const codeForA = await otpGenerate({ secret: secretA })
    const result = await verifyTOTPCode(secretB, codeForA)
    expect(result.valid).toBe(false)
  })

  it('rejects malformed input (non-6-digit) without ever reaching the crypto library', async () => {
    const secret = generateTOTPSecret()
    expect((await verifyTOTPCode(secret, '')).valid).toBe(false)
    expect((await verifyTOTPCode(secret, '12345')).valid).toBe(false)  // too short
    expect((await verifyTOTPCode(secret, '1234567')).valid).toBe(false) // too long
    expect((await verifyTOTPCode(secret, 'abcdef')).valid).toBe(false)  // not digits
  })

  it('REPLAY PROTECTION: a valid code is genuinely rejected on reuse once its timeStep has been consumed', async () => {
    const secret = generateTOTPSecret()
    const code = await otpGenerate({ secret })
    const first = await verifyTOTPCode(secret, code)
    expect(first.valid).toBe(true)

    const replay = await verifyTOTPCode(secret, code, first.timeStep)
    expect(replay.valid).toBe(false)
  })

  it('a code is still accepted when afterTimeStep is from a genuinely earlier step', async () => {
    const secret = generateTOTPSecret()
    const code = await otpGenerate({ secret })
    const result = await verifyTOTPCode(secret, code, /* afterTimeStep: */ 0) // epoch 0 — always in the past
    expect(result.valid).toBe(true)
  })
})

describe('backup codes', () => {
  it('generates 10 codes by default, each in XXXXX-XXXXX format', () => {
    const codes = generateBackupCodes()
    expect(codes).toHaveLength(10)
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
  })

  it('excludes visually-ambiguous characters (0, O, 1, I, L)', () => {
    const codes = generateBackupCodes(50) // enough codes that an excluded char would very likely show up if it weren't actually excluded
    const allChars = codes.join('')
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      expect(allChars).not.toContain(bad)
    }
  })

  it('generates a custom count when asked', () => {
    expect(generateBackupCodes(3)).toHaveLength(3)
  })

  it('generates unique codes within one batch', () => {
    const codes = generateBackupCodes(20)
    expect(new Set(codes).size).toBe(20)
  })

  it('hashBackupCode is deterministic for the same code', () => {
    expect(hashBackupCode('ABCDE-FGHJK')).toBe(hashBackupCode('ABCDE-FGHJK'))
  })

  it('hashBackupCode normalizes case and the separator', () => {
    expect(hashBackupCode('abcde-fghjk')).toBe(hashBackupCode('ABCDE-FGHJK'))
    expect(hashBackupCode('ABCDEFGHJK')).toBe(hashBackupCode('ABCDE-FGHJK'))
  })

  it('verifyBackupCode finds a real match among several stored hashes', () => {
    const codes = generateBackupCodes(5)
    const hashed = codes.map(hashBackupCode)
    const result = verifyBackupCode(codes[2], hashed)
    expect(result.valid).toBe(true)
    expect(result.matchedHash).toBe(hashed[2])
  })

  it('verifyBackupCode rejects a code that was never issued', () => {
    const hashed = generateBackupCodes(5).map(hashBackupCode)
    const result = verifyBackupCode('ZZZZZ-99999', hashed)
    expect(result.valid).toBe(false)
    expect(result.matchedHash).toBeUndefined()
  })

  it('verifyBackupCode against an empty list (all codes already used) always rejects', () => {
    expect(verifyBackupCode('ABCDE-FGHJK', []).valid).toBe(false)
  })
})
