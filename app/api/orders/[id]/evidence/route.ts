import { db } from '@/lib/db';
import { buildEvidence, evidencePdfLines } from '@/src/server/evidence';
import { renderPdf } from '@/src/server/pdf';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Evidence package download: ?format=json (default) or ?format=pdf. Session-owned.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = new URL(request.url).searchParams.get('format') === 'pdf' ? 'pdf' : 'json';
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const pkg = await buildEvidence(db, session.id, id);
    if (!pkg) return Response.json({ error: 'Order not found.' }, { status: 404 });
    // Order IDs are cuids; anything else is dropped from the file name.
    const name = `trustcart-evidence-${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
    if (format === 'json') {
      return new Response(JSON.stringify(pkg, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}.json"` } });
    }
    const pdf = renderPdf(evidencePdfLines(pkg), `TrustCart evidence ${id}`);
    return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}.pdf"` } });
  } catch { return Response.json({ error: 'Could not build the evidence package.' }, { status: 500 }); }
}
