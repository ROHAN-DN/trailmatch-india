/**
 * lib/encryption.ts
 *
 * Generic AES-256-GCM encrypt/decrypt, extracted from lib/mfa.ts so it
 * can be reused for other long-lived credentials (starting with
 * per-organization LLM API keys) without duplicating crypto code.
 *
 * Deliberately parameterized by an explicit key rather than reading a
 * specific env var itself — callers own which key (and which env var)
 * a given secret type uses. This matters for real key isolation: an MFA
 * secret and an org's OpenAI API key are different blast radii, and
 * should never be encryptable/decryptable with the same key.
 *
 * lib/mfa.ts's encryptSecret()/decryptSecret() now call this internally
 * — their public signatures are unchanged, so nothing that already
 * calls them (4 API routes, the existing MFA test suite) needed to
 * change at all. This file is the only thing that's new.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const ALGORITHM  = 'aes-256-gcm'
const IV_LENGTH  = 12 // standard/recommended IV size for GCM

/** Parses and validates a hex-encoded 32-byte (256-bit) key. Throws with a clear, actionable message on any mismatch — never fails silently into a weak or wrong-length key. */
export function parseEncryptionKey(hexKey: string, envVarNameForErrorMessage: string): Buffer {
  const buf = Buffer.from(hexKey, 'hex')
  if (buf.length !== 32) {
    throw new Error(`${envVarNameForErrorMessage} must decode to exactly 32 bytes (64 hex characters) for AES-256 — got ${buf.length} bytes.`)
  }
  return buf
}

/** Encrypts plaintext with the given key. Output format: `iv:authTag:ciphertext`, all hex — self-contained, no separate IV storage needed. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

/** Decrypts a value produced by encrypt(). Throws (does not silently return garbage) on any tampering, corruption, or wrong key — GCM's auth tag check fails closed. */
export function decrypt(encoded: string, key: Buffer): string {
  const parts = encoded.split(':')
  if (parts.length !== 3) throw new Error('Malformed encrypted value — expected iv:authTag:ciphertext format.')
  const [ivHex, authTagHex, dataHex] = parts
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return decrypted.toString('utf8')
}
