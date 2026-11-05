import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { executeRefund } from '@/src/server/protection';
import { paymentProvider } from '@/src/server/payments/select';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Submits a refund draft to the payment provider. Body: { mode: 'PARTIAL' | 'FULL', amountCents? }. The amount is
// validated on the server against the capture and the refunds already made; the capture ID comes from the stored order.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  const { id } = await params;
  const input = await request.json().catch(() => null);
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await executeRefund(db, paymentProvider(), session.id, id, input);
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: 'Could not process the refund. Try again.' }, { status: 500 }); }
}
