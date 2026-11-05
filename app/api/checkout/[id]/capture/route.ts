import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { capturePayment } from '@/src/server/orders';
import { paymentProvider } from '@/src/server/payments/select';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Called by /checkout/return. Takes no body: the PayPal order ID, amount and payee all come from the stored order.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  const { id } = await params;
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await capturePayment(db, paymentProvider(), session.id, id);
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: 'Could not complete the payment. Try again.' }, { status: 500 }); }
}
