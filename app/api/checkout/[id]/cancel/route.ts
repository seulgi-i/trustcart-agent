import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { cancelPayment } from '@/src/server/orders';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Called by /checkout/cancel. Never calls the payment provider.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  const { id } = await params;
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await cancelPayment(db, session.id, id);
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: 'Could not cancel the payment. Try again.' }, { status: 500 }); }
}
