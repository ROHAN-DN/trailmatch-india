import { describe, it, expect } from 'vitest'
import { encrypt, decrypt, parseEncryptionKey } from '../encryption'

const VALID_KEY_HEX = 'a'.repeat(64) // 32 bytes hex-encoded

describe('parseEncryptionKey', () => {
  it('accepts a valid 32-byte hex key', () => {
    const key = parseEncryptionKey(VALID_KEY_HEX, 'TEST_KEY')
    expect(key.length).toBe(32)
  })

  it('rejects a key of the wrong length with a clear, actionable message naming the actual env var', () => {
    expect(() => parseEncryptionKey('abcd', 'LLM_CREDENTIAL_ENCRYPTION_KEY'))
      .toThrow('LLM_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters) for AES-256 — got 2 bytes.')
  })
})

describe('encrypt / decrypt round-trip', () => {
  const key = parseEncryptionKey(VALID_KEY_HEX, 'TEST_KEY')

  it('recovers the exact original plaintext', () => {
    const plaintext = 'sk-real-looking-api-key-1234567890'
    const encrypted = encrypt(plaintext, key)
    expect(decrypt(encrypted, key)).toBe(plaintext)
  })

  it('produces a different ciphertext each time (random IV) even for the same plaintext — no pattern leakage', () => {
    const a = encrypt('same-secret', key)
    const b = encrypt('same-secret', key)
    expect(a).not.toBe(b)
    expect(decrypt(a, key)).toBe('same-secret')
    expect(decrypt(b, key)).toBe('same-secret')
  })

  it('output is self-contained iv:authTag:ciphertext, all hex', () => {
    const encrypted = encrypt('x', key)
    const parts = encrypted.split(':')
    expect(parts).toHaveLength(3)
    for (const p of parts) expect(p).toMatch(/^[0-9a-f]+$/)
  })

  it('fails closed (throws) rather than returning garbage on a tampered ciphertext', () => {
    const encrypted = encrypt('sensitive-value', key)
    const [iv, authTag, data] = encrypted.split(':')
    const tampered = `${iv}:${authTag}:${data.slice(0, -2)}00`
    expect(() => decrypt(tampered, key)).toThrow()
  })

  it('fails closed (throws) when decrypted with the wrong key — this is what makes separate keys for MFA vs LLM credentials actually meaningful', () => {
    const otherKey = parseEncryptionKey('b'.repeat(64), 'OTHER_KEY')
    const encrypted = encrypt('secret', key)
    expect(() => decrypt(encrypted, otherKey)).toThrow()
  })

  it('rejects a malformed value with a clear error rather than crashing unhelpfully', () => {
    expect(() => decrypt('not-the-right-format', key)).toThrow('Malformed encrypted value')
  })
})
