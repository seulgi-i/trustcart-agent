import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { checkBilling } from '@/src/server/protection';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Demo control: simulate the merchant's billing for a scenario and compare it with the signed mandate. A mismatch
// creates a refund draft with the evidence. Body: { scenario }.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  const { id } = await params;
  const input = await request.json().catch(() => null);
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await checkBilling(db, session.id, id, input);
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: 'Could not check the billing. Try again.' }, { status: 500 }); }
}
