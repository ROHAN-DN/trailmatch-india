/**
 * lib/mfa.ts
 *
 * TOTP-based MFA for privileged roles (owner, admin — see
 * PRIVILEGED_ROLES below). Chosen over SMS/email OTP deliberately: no new
 * delivery dependency (this project already depends on Gupshup for
 * WhatsApp and Resend for email, both third-party services with their
 * own failure modes; TOTP needs neither), works with any standard
 * authenticator app, and is the most widely adopted second factor for
 * exactly this kind of B2B SaaS admin console.
 *
 * Built on otplib v13 (verified empirically against the actual installed
 * package before writing any of this — v13 is a complete API rewrite
 * from the `authenticator` object older otplib versions and most
 * tutorials describe; using that older API here would not have worked at
 * all) and the qrcode package for enrollment QR codes.
 */

import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import { generateSecret as otpGenerateSecret, verify as otpVerify, generateURI } from 'otplib'
import QRCode from 'qrcode'
import type { UserRole } from './types/domain'
import { encrypt, decrypt, parseEncryptionKey } from './encryption'

/** Roles that require MFA — the "privileged roles" this project's own Tier 4 disclosure named. Not coordinator/viewer: those can't manage team members, billing, or org settings, and forcing MFA on every staff account across a hospital would be a real adoption barrier for a control that matters most where the actual privilege is. */
export const PRIVILEGED_ROLES: UserRole[] = ['owner', 'admin']

export function roleRequiresMFA(role: UserRole | string | null | undefined): boolean {
  return PRIVILEGED_ROLES.includes(role as UserRole)
}

// ── Secret encryption at rest ───────────────────────────────────
// A TOTP secret is a long-lived credential equivalent — anyone who reads
// it can generate valid codes forever, unlike a login session token that
// naturally expires. It is never stored in the database in plaintext.
// AES-256-GCM: authenticated encryption (tamper-evident, not just
// confidential) using Node's built-in crypto — no new crypto dependency
// for this specific operation, consistent with lib/fidelius.ts's own use
// of well-established, standard primitives rather than anything novel.

function getEncryptionKey(): Buffer {
  const key = process.env.MFA_ENCRYPTION_KEY
  if (!key) {
    throw new Error(
      'MFA_ENCRYPTION_KEY environment variable is not set. Generate one with ' +
      '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` ' +
      'and set it before any MFA secret can be encrypted or decrypted.'
    )
  }
  return parseEncryptionKey(key, 'MFA_ENCRYPTION_KEY')
}

/** Encrypts a TOTP secret for storage. Output format: `iv:authTag:ciphertext`, all hex — self-contained, no separate IV storage needed. */
export function encryptSecret(plaintext: string): string {
  return encrypt(plaintext, getEncryptionKey())
}

/** Decrypts a secret produced by encryptSecret. Throws (does not silently return garbage) on any tampering, corruption, or wrong key — GCM's auth tag check fails closed. */
export function decryptSecret(encoded: string): string {
  return decrypt(encoded, getEncryptionKey())
}

// ── TOTP enrollment ──────────────────────────────────────────────

export function generateTOTPSecret(): string {
  return otpGenerateSecret() // base32-encoded, e.g. 'JBSWY3DPEHPK3PXP' — verified format empirically
}

export function buildOtpAuthUri(secret: string, accountEmail: string): string {
  return generateURI({ issuer: 'TrialMatch India', label: accountEmail, secret })
}

export async function generateEnrollmentQRCode(otpAuthUri: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUri) // data:image/png;base64,... — verified empirically
}

// ── TOTP verification, with real replay protection ──────────────
// otplib v13 has native replay protection built in (afterTimeStep
// rejects any token at or before a previously-consumed time step) —
// verified empirically, including that a replayed code is genuinely
// rejected, before relying on it here. This matters: without it, a code
// intercepted once (shoulder-surfed, logged, whatever) stays valid for
// its full ~30s window and could be reused within that window.

export interface TOTPVerification {
  valid: boolean
  /** Only present when valid — persist this and pass it as afterTimeStep on the next verification for this user, closing the replay window. */
  timeStep?: number
}

export async function verifyTOTPCode(
  secret: string,
  token: string,
  afterTimeStep?: number | null
): Promise<TOTPVerification> {
  // A blank/malformed token should never reach otplib's verify at all —
  // fail fast and explicitly rather than let an edge case in an
  // unfamiliar library's input handling decide this.
  if (!/^\d{6}$/.test(token)) return { valid: false }

  try {
    const result = await otpVerify({
      secret, token,
      strategy: 'totp',
      epochTolerance: [30, 30], // ±1 time step — accounts for real-world clock drift between the server and the user's phone, without opening a wide window
      ...(afterTimeStep != null ? { afterTimeStep } : {}),
    })
    // verify()'s static return type is a union across TOTP and HOTP
    // results (it isn't a conditional type keyed on `strategy`), so
    // `timeStep` isn't visible to TypeScript even though it's always
    // present at runtime for a TOTP result — a real gap between what the
    // library's types express and what its documented behavior
    // guarantees (verified empirically above). Checked at runtime rather
    // than asserted, so this degrades safely if that ever isn't true.
    if (!result.valid) return { valid: false }
    return 'timeStep' in result ? { valid: true, timeStep: result.timeStep } : { valid: true }
  } catch {
    // A malformed secret, a library-internal error, anything unexpected —
    // fails closed (not verified), never throws past this function. MFA
    // verification failing open on an unexpected error would defeat the
    // entire point of the control.
    return { valid: false }
  }
}

// ── Backup / recovery codes ──────────────────────────────────────
// For when the authenticator device is lost — without these, losing a
// phone means permanent lockout for an owner/admin account, which is a
// real, serious support problem, not just an inconvenience. Single-use,
// shown to the user exactly once at enrollment, stored hashed (never
// plaintext — equivalent to a password in what it grants).

// Excludes visually-ambiguous characters (0/O, 1/I/L) — these are meant
// to be hand-typed from a printed or written-down copy.
const BACKUP_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateOneBackupCode(): string {
  const bytes = randomBytes(10)
  let raw = ''
  for (const b of bytes) raw += BACKUP_CODE_CHARSET[b % BACKUP_CODE_CHARSET.length]
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`
}

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, generateOneBackupCode)
}

/** SHA-256 is appropriate here (unlike password hashing) — these are single-use, high-entropy (50 bits) random strings, not low-entropy human-chosen secrets vulnerable to offline brute force at speed. */
export function hashBackupCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Checks a submitted code against the user's stored (hashed) backup
 * codes. Constant-time comparison against every stored hash — not a
 * short-circuiting loop that returns on first match via `===`, which
 * would leak timing information about which stored codes don't match.
 * Returns the matched hash so the caller can remove exactly that one
 * (single-use) without needing to re-hash or guess which one matched.
 */
export function verifyBackupCode(code: string, hashedCodes: string[]): { valid: boolean; matchedHash?: string } {
  const submittedHash = Buffer.from(hashBackupCode(code), 'hex')
  let matchedHash: string | undefined
  for (const stored of hashedCodes) {
    const storedBuf = Buffer.from(stored, 'hex')
    if (storedBuf.length === submittedHash.length && timingSafeEqual(storedBuf, submittedHash)) {
      matchedHash = stored
      // Deliberately no `break` — keep comparing against every remaining
      // hash so the function takes the same time regardless of where in
      // the list (or whether at all) the match occurred.
    }
  }
  return matchedHash ? { valid: true, matchedHash } : { valid: false }
}
