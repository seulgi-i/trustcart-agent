import { db } from '@/lib/db';
import { verifyOrderMandate } from '@/src/server/protection';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Verifies the stored mandate signature with the server's public key. Read-only; session-owned.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await verifyOrderMandate(db, session.id, id);
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: 'Could not verify the mandate.' }, { status: 500 }); }
}
