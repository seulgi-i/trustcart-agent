import { z } from 'zod';
import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { decideOrder } from '@/src/server/orders';
import { paymentProvider } from '@/src/server/payments/select';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Approve or confirm creates the provider order and returns the buyer approval URL; nothing is captured here.
// Reject never touches the provider.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  let status: 'APPROVED' | 'REJECTED';
  try { status = z.object({ status: z.enum(['APPROVED', 'REJECTED']) }).parse(await request.json()).status; }
  catch { return Response.json({ error: 'status must be APPROVED or REJECTED.' }, { status: 400 }); }
  const { id } = await params;
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await decideOrder(db, paymentProvider(), session.id, id, status);
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: 'Could not process the decision. Try again.' }, { status: 500 }); }
}
