import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, type MandatePayload } from '@/src/domain/mandate';

// Server-only Ed25519 signing of intent mandates. The key comes from MANDATE_SIGNING_KEY (base64 of a PKCS8 PEM).
// Outside production a fixed, publicly known development key is derived instead, with a warning, so mandates stay
// verifiable across dev restarts and test runs. In production a missing or invalid key throws: capture refuses to
// start rather than take money without a mandate.

export type MandateSigner = { privateKey: KeyObject; publicKey: KeyObject; publicKeyPem: string; fingerprint: string; dev: boolean };
export type SignedMandate = { payload: string; signature: string; publicKeyFingerprint: string };
type Env = Record<string, string | undefined>;

// PKCS8 DER header for an Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const DEV_SEED = createHash('sha256').update('trustcart-dev-mandate-signing-key (not secret)').digest();

// sha256 of the SPKI DER, hex.
export const publicKeyFingerprint = (publicKey: KeyObject) => createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

export function loadMandateSigner(env: Env = process.env): MandateSigner {
  const raw = env.MANDATE_SIGNING_KEY?.trim();
  let privateKey: KeyObject;
  if (raw) {
    // The value is never echoed: a parse error only says what shape is expected.
    try { privateKey = createPrivateKey({ key: Buffer.from(raw, 'base64').toString('utf8'), format: 'pem' }); }
    catch { throw new Error('MANDATE_SIGNING_KEY must be the base64 of a PKCS8 PEM Ed25519 private key.'); }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('MANDATE_SIGNING_KEY must be an Ed25519 private key.');
  } else {
    if (env.NODE_ENV === 'production') throw new Error('Set MANDATE_SIGNING_KEY. Payments are refused in production without a mandate signing key.');
    privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, DEV_SEED]), format: 'der', type: 'pkcs8' });
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: publicKeyFingerprint(publicKey), dev: !raw };
}

// One signer per server process. A load that throws is not cached, so fixing the env and retrying works.
const globalForSigner = globalThis as unknown as { mandateSigner?: MandateSigner };
export function mandateSigner(): MandateSigner {
  if (!globalForSigner.mandateSigner) {
    const signer = loadMandateSigner();
    if (signer.dev) console.warn('MANDATE_SIGNING_KEY is not set: signing mandates with the public development key. Never use this outside local development.');
    globalForSigner.mandateSigner = signer;
  }
  return globalForSigner.mandateSigner;
}

export function signMandate(signer: MandateSigner, payload: MandatePayload): SignedMandate {
  const canonical = canonicalJson(payload);
  return { payload: canonical, signature: sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('base64'), publicKeyFingerprint: signer.fingerprint };
}

export function verifySignature(payload: string, signature: string, publicKey: KeyObject) {
  try { return verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64')); } catch { return false; }
}

export type MandateVerification = {
  valid: boolean;
  checks: { signature: boolean; keyFingerprint: boolean; canonical: boolean; orderBinding: boolean };
  publicKeyFingerprint: string;
};

// Valid only if the signature verifies under the server's key, the stored fingerprint is that key's, the payload is
// in canonical form and it names this order and its capture.
export function verifyMandate(record: SignedMandate, signer: MandateSigner, expected: { orderId: string; captureId: string | null }): MandateVerification {
  let parsed: Partial<MandatePayload> | null = null;
  try { parsed = JSON.parse(record.payload) as Partial<MandatePayload>; } catch { /* not JSON: every content check fails */ }
  const checks = {
    signature: verifySignature(record.payload, record.signature, signer.publicKey),
    keyFingerprint: record.publicKeyFingerprint === signer.fingerprint,
    canonical: parsed !== null && canonicalJson(parsed) === record.payload,
    orderBinding: parsed?.orderId === expected.orderId && parsed.payment?.captureId === expected.captureId,
  };
  return { valid: Object.values(checks).every(Boolean), checks, publicKeyFingerprint: signer.fingerprint };
}
