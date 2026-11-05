import { mandateSigner } from '@/src/server/mandate';
export const runtime = 'nodejs';

// Public half of the mandate signing key, so anyone holding an evidence package can verify it independently.
export async function GET() {
  try {
    const { publicKeyPem, fingerprint, dev } = mandateSigner();
    return Response.json({ algorithm: 'Ed25519', publicKeyPem, fingerprint, fingerprintAlgorithm: 'sha256(SPKI DER)', developmentKey: dev });
  } catch { return Response.json({ error: 'Mandate signing is not configured.' }, { status: 500 }); }
}
