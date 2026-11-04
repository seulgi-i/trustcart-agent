import { z } from 'zod';
import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { isUsdAmount, usdToCents } from '@/src/domain/money';
import { HARD_CAP_CENTS, MAX_UNITS_PER_LINE } from '@/src/domain/policy';
import { latestIntent, setIntent } from '@/src/server/orders';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

const intentSchema = z.object({
  budgetUSD: z.number().positive().max(HARD_CAP_CENTS / 100).refine(isUsdAmount, 'Use cents precision'),
  category: z.string().min(1).max(40),
  quantity: z.number().int().min(1).max(MAX_UNITS_PER_LINE),
});

export async function GET(request: Request) {
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const intent = await latestIntent(db, session.id);
    const categories = (await db.product.findMany({ distinct: ['category'], select: { category: true } })).map(p => p.category);
    return Response.json({ intent: intent && { budgetCents: intent.budgetCents, category: intent.category, quantity: intent.quantity }, categories, hardCapCents: HARD_CAP_CENTS });
  } catch {
    return Response.json({ error: 'Could not load the purchase intent.' }, { status: 500 });
  }
}

// Only the user's browser sets the intent. The agent has no tool for it.
export async function POST(request: Request) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const parsed = intentSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: `Budget must be $0.01–$${HARD_CAP_CENTS / 100}, quantity 1–${MAX_UNITS_PER_LINE}.` }, { status: 400 });
    if (!await db.product.findFirst({ where: { category: parsed.data.category } })) return Response.json({ error: 'Unknown category.' }, { status: 400 });
    const { budgetUSD, category, quantity } = parsed.data;
    await setIntent(db, session.id, { budgetCents: usdToCents(budgetUSD), category, quantity });
    return Response.json({ ok: true }, { status: 201 });
  } catch {
    return Response.json({ error: 'Could not save the purchase intent.' }, { status: 500 });
  }
}
