/**
 * lib/__tests__/fidelius.test.ts
 *
 * The core assertion here (`matches the independently-verified test
 * vector`) is the strongest guarantee available in this environment that
 * lib/fidelius.ts implements ABDM's actual Fidelius protocol rather than
 * a plausible-looking approximation of it:
 *
 *  - The test vector's expected output was produced by dimagi/pyfidelius,
 *    a real, maintained, open-source Python reference implementation,
 *    installed and run directly from its source in the same session that
 *    wrote this file (not recalled from memory, not trusted from a blog).
 *  - It matches, byte-for-byte, a test vector separately published by an
 *    unrelated blog post describing a from-scratch TypeScript port.
 *  - This file's implementation (different language, different EC library,
 *    different AES-GCM library) reproduces the same output.
 *
 * Three independent implementations producing identical ciphertext for
 * identical inputs is strong evidence the algorithm is right. It is NOT
 * evidence this interoperates with ABDM's actual live gateway — that
 * requires testing against the real ABDM sandbox, which this environment
 * cannot reach.
 */
import { describe, it, expect } from 'vitest'
import { generateKeyMaterial, encrypt, decrypt } from '../fidelius'

describe('Fidelius — published test vector (dimagi/pyfidelius)', () => {
  const senderNonce      = 'lmXgblZwotx+DfBgKJF0lZXtAXgBEYr5khh79Zytr2Y='
  const requesterNonce   = '6uj1RdDUbcpI3lVMZvijkMC8Te20O4Bcyz0SyivX8Eg='
  const senderPrivateKey = 'AYhVZpbVeX4KS5Qm/W0+9Ye2q3rnVVGmqRICmseWni4='
  const requesterPublicKey = 'BAheD5rUqTy4V5xR4/6HWmYpopu5CO+KO8BECS0udNqUTSNo91TIqIIy1A4Vh+F94c+n9vAcwXU2bGcfsI5f69Y='
  const requesterPrivateKey = 'DMxHPri8d7IT23KgLk281zZenMfVHSdeamq0RhwlIBk='
  const senderPublicKey  = 'BABVt+mpRLMXiQpIfEq6bj8hlXsdtXIxLsspmMgLNI1SR5mHgDVbjHO2A+U4QlMddGzqyEidzm1AkhtSxSO2Ahg='
  const plaintext = "Wormtail should never have been Potter cottage's secret keeper."
  const expectedCiphertext = 'pzMvVZNNVtJzqPkkxcCbBUWgDEBy/mBXIeT2dJWI16ZAQnnXUb9lI+S4k8XK6mgZSKKSRIHkcNvJpllnBg548wUgavBa0vCRRwdL6kY6Yw=='

  it('reproduces the exact published ciphertext byte-for-byte', () => {
    const result = encrypt({
      senderNonce, requesterNonce,
      senderPrivateKey, requesterPublicKey,
      plaintext,
    })
    expect(result).toBe(expectedCiphertext)
  })

  it('decrypts the published ciphertext back to the exact plaintext, with tag verification passing', () => {
    const result = decrypt({
      senderNonce, requesterNonce,
      requesterPrivateKey, senderPublicKey,
      encryptedData: expectedCiphertext,
    })
    expect(result).toBe(plaintext)
  })
})

describe('Fidelius — fresh keypairs', () => {
  it('round-trips a message between two freshly generated keypairs', () => {
    const alice = generateKeyMaterial()
    const bob   = generateKeyMaterial()
    const message = 'TrialMatch India — round trip with fresh keys.'

    const ciphertext = encrypt({
      senderNonce: alice.nonce, requesterNonce: bob.nonce,
      senderPrivateKey: alice.privateKey, requesterPublicKey: bob.publicKey,
      plaintext: message,
    })
    const decrypted = decrypt({
      senderNonce: alice.nonce, requesterNonce: bob.nonce,
      requesterPrivateKey: bob.privateKey, senderPublicKey: alice.publicKey,
      encryptedData: ciphertext,
    })
    expect(decrypted).toBe(message)
  })

  it('round-trips correctly using the X.509-wrapped public key format (what ABDM\'s keyValue field actually expects)', () => {
    const alice = generateKeyMaterial()
    const bob   = generateKeyMaterial()
    const message = 'Testing X.509-wrapped key format.'

    const ciphertext = encrypt({
      senderNonce: alice.nonce, requesterNonce: bob.nonce,
      senderPrivateKey: alice.privateKey, requesterPublicKey: bob.x509PublicKey,
      plaintext: message,
    })
    const decrypted = decrypt({
      senderNonce: alice.nonce, requesterNonce: bob.nonce,
      requesterPrivateKey: bob.privateKey, senderPublicKey: alice.x509PublicKey,
      encryptedData: ciphertext,
    })
    expect(decrypted).toBe(message)
  })

  it('produces a different keypair on every call (ephemeral, forward-secret)', () => {
    const a = generateKeyMaterial()
    const b = generateKeyMaterial()
    expect(a.privateKey).not.toBe(b.privateKey)
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.nonce).not.toBe(b.nonce)
  })

  it('rejects a tampered ciphertext instead of silently returning garbage', () => {
    const alice = generateKeyMaterial()
    const bob   = generateKeyMaterial()
    const ciphertext = encrypt({
      senderNonce: alice.nonce, requesterNonce: bob.nonce,
      senderPrivateKey: alice.privateKey, requesterPublicKey: bob.publicKey,
      plaintext: 'sensitive health data',
    })
    const tampered = Buffer.from(ciphertext, 'base64')
    tampered[0] ^= 0xff

    expect(() => decrypt({
      senderNonce: alice.nonce, requesterNonce: bob.nonce,
      requesterPrivateKey: bob.privateKey, senderPublicKey: alice.publicKey,
      encryptedData: tampered.toString('base64'),
    })).toThrow()
  })

  it('rejects decryption with the wrong private key', () => {
    const alice = generateKeyMaterial()
    const bob   = generateKeyMaterial()
    const eve   = generateKeyMaterial()
    const ciphertext = encrypt({
      senderNonce: alice.nonce, requesterNonce: bob.nonce,
      senderPrivateKey: alice.privateKey, requesterPublicKey: bob.publicKey,
      plaintext: 'sensitive health data',
    })
    expect(() => decrypt({
      senderNonce: alice.nonce, requesterNonce: bob.nonce,
      requesterPrivateKey: eve.privateKey, senderPublicKey: alice.publicKey,
      encryptedData: ciphertext,
    })).toThrow()
  })

  it('round-trips correctly across many freshly generated keypairs — regression guard for a real bug this suite caught: public key coordinates need fixed 32-byte encoding, not minimal-length, because both wire formats are decoded by fixed byte offset. A coordinate with a leading zero byte (~1/256 chance per coordinate) previously misaligned that slicing and broke decryption.', () => {
    for (let i = 0; i < 100; i++) {
      const alice = generateKeyMaterial()
      const bob   = generateKeyMaterial()
      const message = `Round trip attempt ${i}`
      const ciphertext = encrypt({
        senderNonce: alice.nonce, requesterNonce: bob.nonce,
        senderPrivateKey: alice.privateKey, requesterPublicKey: bob.publicKey,
        plaintext: message,
      })
      const decrypted = decrypt({
        senderNonce: alice.nonce, requesterNonce: bob.nonce,
        requesterPrivateKey: bob.privateKey, senderPublicKey: alice.publicKey,
        encryptedData: ciphertext,
      })
      expect(decrypted).toBe(message)
    }
  })
})
