/**
 * lib/abdm-client.ts
 * ABDM (Ayushman Bharat Digital Mission) API client.
 *
 * Implements the ABDM HIU (Health Information User) flow:
 *  1. Authenticate → get gateway access token
 *  2. Find patient by ABHA number/address → get health ID
 *  3. Request OTP verification → confirm patient identity
 *  4. Submit health info consent request
 *  5. ABDM calls our callback with FHIR bundle (async)
 *  6. Parse FHIR bundle → TrialMatch patient record
 *
 * ABDM Sandbox: https://sandbox.abdm.gov.in/
 * HIU API docs:  https://sandbox.abdm.gov.in/docs/health_records
 * FHIR profile:  https://nrces.in/ndhm/fhir/r4/
 *
 * ── Auth flow ─────────────────────────────────────────────────
 * ABDM uses OAuth2 client credentials for gateway auth.
 * Access tokens expire in 5 minutes — we cache and refresh.
 *
 * ── Data flow ─────────────────────────────────────────────────
 * Health data comes via ABDM's push model:
 *  - We POST a request to ABDM
 *  - ABDM calls our /api/abdm/callback with the FHIR bundle
 *  - We store the bundle, parse it, create the patient record
 *
 * This is tracked via abdm_sessions in Supabase.
 */

import {
  generateKeyMaterial as generateFideliusKeyMaterial,
  decrypt as fideliusDecrypt,
  type FideliusKeyMaterial,
} from './fidelius'

const GATEWAY  = process.env.ABDM_GATEWAY_URL  || 'https://dev.abdm.gov.in/gateway'
const HIU_URL  = process.env.ABDM_HEALTH_INFO_URL || 'https://dev.abdm.gov.in/hiu'
const CLIENT_ID     = process.env.ABDM_CLIENT_ID!
const CLIENT_SECRET = process.env.ABDM_CLIENT_SECRET!
const HIU_ID        = process.env.ABDM_HIU_ID!
const CALLBACK_URL  = process.env.ABDM_CALLBACK_URL!

// ── Token cache (in-memory, resets on cold start) ─────────────
let cachedToken:    string | null = null
let tokenExpiresAt: number = 0

// ── Get (or refresh) gateway access token ────────────────────
export async function getGatewayToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) {
    return cachedToken
  }

  const res = await fetch(`${GATEWAY}/v0.5/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId:     CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ABDM auth failed (${res.status}): ${err}`)
  }

  const data = await res.json()
  cachedToken    = data.accessToken
  // ABDM tokens expire in 300s (5 min), cache for 4.5 min
  tokenExpiresAt = Date.now() + (data.expiresIn || 300) * 1000
  return cachedToken!
}

// ── Utility: build request headers ───────────────────────────
async function headers(extra?: Record<string, string>) {
  const token = await getGatewayToken()
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
    'X-CM-ID':       'sbx',           // sandbox CM; prod: 'abdm'
    ...extra,
  }
}

function timestamp() { return new Date().toISOString() }
function uuid()      { return crypto.randomUUID() }

// ══════════════════════════════════════════════════════════════
// STEP 1: Verify ABHA number exists and get patient details
// ══════════════════════════════════════════════════════════════
export async function verifyABHA(abhaNumber: string): Promise<{
  abhaNumber: string
  name: string
  gender: string
  yearOfBirth: number
  mobile: string   // masked, e.g. ******1234
}> {
  // Normalise ABHA: remove dashes, ensure 14 digits
  const clean = abhaNumber.replace(/[-\s]/g, '')
  if (!/^\d{14}$/.test(clean)) {
    throw new Error('Invalid ABHA number. It must be 14 digits (e.g. 12-3456-7890-1234)')
  }

  const res = await fetch(`${GATEWAY}/v0.5/patients/profile/on-fetch`, {
    method:  'POST',
    headers: await headers(),
    body:    JSON.stringify({
      requestId:  uuid(),
      timestamp:  timestamp(),
      query: {
        id:         clean,
        purpose:    'KYC_AND_LINK',
        authMode:   'MOBILE_OTP',
        requester: { type: 'HIP', id: HIU_ID },
      },
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`ABHA lookup failed: ${err.error?.message || res.statusText}`)
  }

  const data = await res.json()
  const profile = data.patient || data

  return {
    abhaNumber:  clean,
    name:        profile.name        || 'Unknown',
    gender:      profile.gender      || 'Unknown',
    yearOfBirth: profile.yearOfBirth || 0,
    mobile:      profile.mobile      || '**masked**',
  }
}

// ══════════════════════════════════════════════════════════════
// STEP 2: Initiate OTP — sends OTP to patient's registered mobile
// ══════════════════════════════════════════════════════════════
export async function initiateABHAOTP(abhaNumber: string): Promise<{
  transactionId: string
  message:       string
}> {
  const clean = abhaNumber.replace(/[-\s]/g, '')

  const res = await fetch(`${GATEWAY}/v0.5/users/auth/init`, {
    method:  'POST',
    headers: await headers(),
    body:    JSON.stringify({
      requestId:  uuid(),
      timestamp:  timestamp(),
      query: {
        id:       clean,
        purpose:  'KYC_AND_LINK',
        authMode: 'MOBILE_OTP',
        requester: { type: 'HIP', id: HIU_ID },
      },
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`OTP initiation failed: ${err.error?.message || res.statusText}`)
  }

  const data = await res.json()
  return {
    transactionId: data.transactionId || data.auth?.transactionId,
    message:       'OTP sent to the mobile number registered with your ABHA',
  }
}

// ══════════════════════════════════════════════════════════════
// STEP 3: Confirm OTP — verify OTP and get access token
// ══════════════════════════════════════════════════════════════
export async function confirmABHAOTP(transactionId: string, otp: string): Promise<{
  accessToken:      string
  patientId:        string
  patientName:      string
  expiresIn:        number
}> {
  // ABDM requires OTP to be encrypted with their public key in production
  // For sandbox, plain OTP is accepted
  const res = await fetch(`${GATEWAY}/v0.5/users/auth/confirm`, {
    method:  'POST',
    headers: await headers(),
    body:    JSON.stringify({
      requestId:     uuid(),
      timestamp:     timestamp(),
      transactionId,
      credential: {
        authCode: otp,
      },
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const msg = err.error?.message || res.statusText
    if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expired')) {
      throw new Error('Invalid or expired OTP. Please request a new one.')
    }
    throw new Error(`OTP verification failed: ${msg}`)
  }

  const data = await res.json()
  const auth  = data.auth || data

  return {
    accessToken:  auth.accessToken,
    patientId:    auth.patient?.id || '',
    patientName:  auth.patient?.display || '',
    expiresIn:    auth.accessToken?.expiresIn || 300,
  }
}

// ══════════════════════════════════════════════════════════════
// STEP 4: Request health information
// Returns a requestId we can poll/await for callback, plus the ephemeral
// Fidelius key material — the CALLER must persist this (e.g. onto the
// abdm_sessions row) because decryptHealthBundle() below needs our
// private key + nonce again when the encrypted callback arrives, and this
// function has no DB access of its own by design.
// ══════════════════════════════════════════════════════════════
export async function requestHealthInfo(params: {
  patientToken:    string   // access token from OTP confirmation
  patientId:       string   // health ID / ABHA address
  sessionId:       string   // our DB session ID (used as callback key)
  hiTypes?: string[]        // health info types to fetch
}): Promise<{ requestId: string; fideliusKeyMaterial: FideliusKeyMaterial }> {
  const {
    patientToken,
    patientId,
    sessionId,
    hiTypes = [
      'OPConsultation',
      'DiagnosticReport',
      'DischargeSummary',
      'Prescription',
      'HealthDocumentRecord',
    ],
  } = params

  const requestId  = uuid()
  const now        = new Date()
  const dateTo     = new Date(now.getTime() + 5 * 60_000).toISOString()  // 5 min from now
  const dateFrom   = new Date(now.getFullYear() - 5, 0, 1).toISOString() // 5 years back

  // Fresh ephemeral keypair per request — perfect forward secrecy means
  // this must never be reused across sessions. See lib/fidelius.ts for the
  // implementation and how its correctness was verified.
  const fideliusKeyMaterial = generateFideliusKeyMaterial()

  const res = await fetch(`${HIU_URL}/v0.5/health-information/cm/request`, {
    method:  'POST',
    headers: await headers({ 'X-Token': `Bearer ${patientToken}` }),
    body:    JSON.stringify({
      requestId,
      timestamp: timestamp(),
      consent: {
        id: sessionId,   // We use session ID as consent reference
      },
      dateRange: { from: dateFrom, to: dateTo },
      dataPushUrl: `${CALLBACK_URL}?session=${sessionId}`,
      hiTypes,
      keyMaterial: {
        cryptoAlg:  'ECDH',
        curve:      'Curve25519',
        dhPublicKey: {
          expiry:    dateTo,
          parameters: 'Curve25519/32byte',
          // ABDM's keyValue field expects the X.509 DER-wrapped point, not
          // the raw uncompressed point — see lib/fidelius.ts.
          keyValue:   fideliusKeyMaterial.x509PublicKey,
        },
        nonce: fideliusKeyMaterial.nonce,
      },
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Health info request failed: ${err.error?.message || res.statusText}`)
  }

  return { requestId, fideliusKeyMaterial }
}

// ══════════════════════════════════════════════════════════════
// STEP 5: Decrypt incoming FHIR bundle from ABDM callback
//
// Real Fidelius decryption — replaces a previous placeholder that just
// tried base64/JSON parsing and called it "decryption." Requires the
// caller to supply BOTH our own key material (generated in
// requestHealthInfo above and persisted by the caller, e.g. on the
// abdm_sessions row) AND the HIP's public key + nonce from the callback
// payload's own keyMaterial block.
// ══════════════════════════════════════════════════════════════
export function decryptHealthBundle(params: {
  encryptedData:  string  // base64(ciphertext || 16-byte GCM tag) from the callback payload
  hipPublicKey:   string  // base64 — payload.keyMaterial.dhPublicKey.keyValue from the callback
  hipNonce:       string  // base64 — payload.keyMaterial.nonce from the callback
  ourPrivateKey:  string  // base64 — from the session's stored fidelius_private_key
  ourNonce:       string  // base64 — from the session's stored fidelius_nonce
}): any {
  const plaintext = fideliusDecrypt({
    senderNonce:         params.hipNonce,
    requesterNonce:      params.ourNonce,
    requesterPrivateKey: params.ourPrivateKey,
    senderPublicKey:     params.hipPublicKey,
    encryptedData:       params.encryptedData,
  })
  return JSON.parse(plaintext)
}

// ══════════════════════════════════════════════════════════════
// SANDBOX HELPERS — for testing without real ABHA numbers
// ══════════════════════════════════════════════════════════════

/**
 * ABDM Sandbox test ABHA numbers (from official sandbox docs).
 * These work against https://sandbox.abdm.gov.in with OTP = 123456
 */
export const SANDBOX_TEST_ABHA = [
  { abha: '12-3456-7890-1234', name: 'Test Patient (Diabetes)',        otp: '123456' },
  { abha: '98-7654-3210-0001', name: 'Test Patient (Hypertension)',     otp: '123456' },
  { abha: '11-2233-4455-6677', name: 'Test Patient (Oncology)',         otp: '123456' },
]

/**
 * Mock health bundle for sandbox testing when ABDM callback isn't reachable.
 * Returns a realistic FHIR R4 bundle matching the test ABHA.
 */
export function getMockHealthBundle(abhaNumber: string): any {
  const isOncology = abhaNumber.includes('1122')
  const isHypertension = abhaNumber.includes('9876')

  return {
    resourceType: 'Bundle',
    id: `abdm-mock-${Date.now()}`,
    type: 'collection',
    meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/Bundle'] },
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: `pt-${abhaNumber.replace(/[-\s]/g, '')}`,
          identifier: [{
            system: 'https://healthid.ndhm.gov.in',
            value:  abhaNumber,
            type:   { coding: [{ code: 'ABHA', display: 'ABHA Number' }] },
          }],
          name: [{ text: isOncology ? 'Priya Sharma' : isHypertension ? 'Rajesh Kumar' : 'Anita Patel' }],
          gender: isHypertension ? 'male' : 'female',
          birthDate: isOncology ? '1975-08-12' : isHypertension ? '1958-03-21' : '1969-11-05',
          address: [{
            city:    isOncology ? 'Chennai' : isHypertension ? 'Delhi' : 'Bengaluru',
            state:   isOncology ? 'Tamil Nadu' : isHypertension ? 'Delhi' : 'Karnataka',
            country: 'India',
          }],
        },
      },
      {
        resource: {
          resourceType: 'Condition',
          id: 'main-condition',
          subject: { reference: `Patient/pt-${abhaNumber.replace(/[-\s]/g, '')}` },
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: {
            coding: [{
              system:  'http://snomed.info/sct',
              code:    isOncology ? '363346000' : isHypertension ? '38341003' : '44054006',
              display: isOncology ? 'Non-Small Cell Lung Cancer' : isHypertension ? 'Hypertension' : 'Type 2 Diabetes Mellitus',
            }],
            text: isOncology ? 'Non-Small Cell Lung Cancer' : isHypertension ? 'Hypertension' : 'Type 2 Diabetes Mellitus',
          },
          severity: { text: isOncology ? 'Stage IIB' : isHypertension ? 'Stage 2' : 'Moderate — HbA1c 8.9%' },
        },
      },
      ...(isHypertension ? [{
        resource: {
          resourceType: 'Condition',
          id: 'comorbid-1',
          subject: { reference: `Patient/pt-${abhaNumber.replace(/[-\s]/g, '')}` },
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: { text: 'Type 2 Diabetes Mellitus' },
        },
      }] : []),
      {
        resource: {
          resourceType: 'MedicationRequest',
          id: 'med-1',
          subject: { reference: `Patient/pt-${abhaNumber.replace(/[-\s]/g, '')}` },
          status: 'active',
          medicationCodeableConcept: {
            text: isOncology ? 'Carboplatin 300mg IV' : isHypertension ? 'Amlodipine 5mg' : 'Metformin 500mg',
          },
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          id: 'lab-1',
          subject: { reference: `Patient/pt-${abhaNumber.replace(/[-\s]/g, '')}` },
          status: 'final',
          code: {
            coding: [{
              system:  'http://loinc.org',
              code:    isOncology ? '2857-1' : isHypertension ? '55284-4' : '4548-4',
              display: isOncology ? 'PSA' : isHypertension ? 'Blood Pressure' : 'HbA1c',
            }],
          },
          valueQuantity: {
            value: isOncology ? 8.4 : isHypertension ? 158 : 8.9,
            unit:  isOncology ? 'ng/mL' : isHypertension ? 'mmHg' : '%',
          },
          effectiveDateTime: new Date().toISOString(),
        },
      },
    ],
  }
}
