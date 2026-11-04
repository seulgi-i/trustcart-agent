import { z } from 'zod';
import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { decideOrder } from '@/src/server/orders';
import { createMockProvider } from '@/src/server/payments/provider';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// D-DEMO runs on the mock provider only. No PayPal request is made from this route.
const provider = createMockProvider();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  let status: 'APPROVED' | 'REJECTED';
  try { status = z.object({ status: z.enum(['APPROVED', 'REJECTED']) }).parse(await request.json()).status; }
  catch { return Response.json({ error: 'status must be APPROVED or REJECTED.' }, { status: 400 }); }
  const { id } = await params;
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const origin = new URL(request.url).origin;
    const result = await decideOrder(db, provider, session.id, id, status, { returnUrl: `${origin}/approvals`, cancelUrl: `${origin}/approvals` });
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: 'Could not process the decision. Try again.' }, { status: 500 }); }
}
