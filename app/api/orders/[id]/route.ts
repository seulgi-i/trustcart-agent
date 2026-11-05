import { db } from '@/lib/db';
import { getOrderProtection } from '@/src/server/protection';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Order view: the order, its signed mandate and its refund requests. This session's orders only.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await getOrderProtection(db, session.id, id);
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: 'Could not load the order.' }, { status: 500 }); }
}
