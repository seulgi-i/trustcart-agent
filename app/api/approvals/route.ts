import { db } from '@/lib/db';
import { listOrders } from '@/src/server/orders';
import { paymentProvider } from '@/src/server/payments/select';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Only the kind is exposed, so the inbox can label mock payments. A misconfigured PayPal setup shows as such.
function providerKind() {
  try { return paymentProvider().kind; } catch { return 'misconfigured'; }
}

// Inbox: this session's orders only. Orders are created by the agent's checkout tool from the server-side cart.
export async function GET(request: Request) {
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const orders = await listOrders(db, session.id);
    return Response.json({ orders, needsReview: orders.filter(o => o.status === 'NEEDS_APPROVAL').length, provider: providerKind() });
  } catch {
    return Response.json({ error: 'Could not load the inbox. Check the database setup.' }, { status: 500 });
  }
}
