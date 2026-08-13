# ABDM Integration Setup Guide

TrialMatch India integrates with the **Ayushman Bharat Digital Mission (ABDM)**
to fetch live patient health records directly using a patient's ABHA number.

---

## How the ABDM HIU flow works

```
Coordinator enters ABHA number
        ↓
TrialMatch verifies ABHA with NHA gateway
        ↓
Patient receives OTP on their registered mobile
        ↓
Coordinator enters OTP → TrialMatch confirms identity
        ↓
TrialMatch sends health info consent request to ABDM
        ↓
ABDM fetches FHIR records from connected hospitals (HIP)
        ↓
ABDM calls TrialMatch callback with encrypted FHIR bundle
        ↓
TrialMatch parses FHIR → creates patient record automatically
```

---

## Step 1 — Register as a Health Information User (HIU)

HIU registration is done through the NHA (National Health Authority).

1. Visit: https://abdm.gov.in/abdm_for_hpr/health_information_user
2. Submit your organisation details:
   - Organisation type: Health Information User (HIU)
   - Use case: Clinical Trial Recruitment
   - Contact: Your hospital/CRO name + GST/PAN
3. NHA reviews and issues:
   - `HIU_ID` — your unique entity identifier
   - `CLIENT_ID` + `CLIENT_SECRET` — for gateway authentication
4. This process takes 2–4 weeks for production credentials.
   **You can use the sandbox immediately — no registration needed.**

---

## Step 2 — Use the Sandbox first

The ABDM sandbox is free and needs no registration.

**Sandbox base URLs:**
```
ABDM_GATEWAY_URL=https://dev.abdm.gov.in/gateway
ABDM_HEALTH_INFO_URL=https://dev.abdm.gov.in/hiu
```

**Sandbox credentials** (use these in .env.local for testing):
```
ABDM_CLIENT_ID=SBX_0014363
ABDM_CLIENT_SECRET=your-test-secret
ABDM_HIU_ID=Demo_HIU
```

Get sandbox credentials at: https://sandbox.abdm.gov.in/

**Sandbox test ABHA numbers** (OTP is always `123456`):
```
12-3456-7890-1234  →  Test Patient (Diabetes)
98-7654-3210-0001  →  Test Patient (Hypertension)
11-2233-4455-6677  →  Test Patient (Oncology)
```

---

## Step 3 — Set up the callback URL

ABDM pushes health data to your server asynchronously.
The callback URL must be publicly accessible.

**Production (Vercel):**
```
ABDM_CALLBACK_URL=https://YOUR_VERCEL_URL/api/abdm/callback
```

**Local development (use ngrok):**
```bash
ngrok http 3000
# Copy the https URL → set ABDM_CALLBACK_URL=https://XXXX.ngrok.io/api/abdm/callback
```

Register your callback URL in the ABDM gateway developer console.

---

## Step 4 — Set up ECDH encryption

ABDM encrypts health data in transit using ECDH (Curve25519).

**For sandbox testing:** Any base64 string works as the encryption key.

**For production:** Generate a proper Curve25519 key pair:

```bash
# Install libsodium (macOS)
brew install libsodium

# Or use Node.js with tweetnacl
npm install tweetnacl

# Generate key pair
node -e "
  const nacl = require('tweetnacl');
  const pair = nacl.box.keyPair();
  console.log('Public key:', Buffer.from(pair.publicKey).toString('base64'));
  console.log('Private key:', Buffer.from(pair.secretKey).toString('base64'));
"
```

Store the private key securely (never in env vars — use Vercel Secrets or AWS KMS).
Pass the public key in health info requests (already wired in `lib/abdm-client.ts`).

For the full production encryption implementation, see:
https://github.com/NHA-ABDM/ABDM-wrapper/tree/main/src/main/java/com/nha/abdm/wrapper/hip/hrp/dataTransfer

---

## Step 5 — Add environment variables

```bash
# .env.local
ABDM_CLIENT_ID=your-client-id
ABDM_CLIENT_SECRET=your-client-secret
ABDM_GATEWAY_URL=https://dev.abdm.gov.in/gateway
ABDM_HEALTH_INFO_URL=https://dev.abdm.gov.in/hiu
ABDM_HIU_ID=your-hiu-id
ABDM_CALLBACK_URL=https://your-domain.com/api/abdm/callback
# No encryption key to set — lib/fidelius.ts generates a fresh ephemeral
# Curve25519 keypair + nonce per session automatically.
```

---

## Step 6 — Run the database migration

```sql
-- Already included in schema.sql — run if you haven't yet:
-- CREATE TABLE abdm_sessions (...)
-- See the abdm_sessions section at the bottom of supabase/schema.sql
```

---

## API routes added

| Route | Method | Purpose |
|---|---|---|
| `/api/abdm/initiate` | POST | Verify ABHA, send OTP, create session |
| `/api/abdm/verify`   | POST | Confirm OTP, request health records |
| `/api/abdm/callback` | POST | ABDM pushes encrypted FHIR bundle here |
| `/api/abdm/status`   | GET  | Poll session status (for live async flow) |

---

## Testing checklist

- [ ] Sandbox credentials added to `.env.local`
- [ ] `ABDM_CALLBACK_URL` set (use ngrok locally)
- [ ] `abdm_sessions` table created in Supabase (check schema.sql)
- [ ] Test with sandbox ABHA `12-3456-7890-1234` and OTP `123456`
- [ ] Verify patient record appears in dashboard after fetch

---

## Production checklist

- [ ] HIU registration approved by NHA
- [ ] Live `CLIENT_ID` and `CLIENT_SECRET` obtained
- [ ] `ABDM_GATEWAY_URL` switched to production endpoint
- [ ] Proper ECDH key pair generated and stored securely
- [ ] Callback URL registered in ABDM production gateway
- [ ] Data processing agreement signed with NHA
- [ ] DPDP Act compliance review completed

---

## Resources

- ABDM sandbox: https://sandbox.abdm.gov.in/
- HIU registration: https://abdm.gov.in/abdm_for_hpr/health_information_user
- FHIR profile (NRCES): https://nrces.in/ndhm/fhir/r4/
- ABDM GitHub: https://github.com/NHA-ABDM/
- ABDM API docs: https://sandbox.abdm.gov.in/docs/
