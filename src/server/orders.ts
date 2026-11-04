import type { PrismaClient } from '@prisma/client';
import { evaluateCart, type CartLine, type Evaluation, type Intent } from '@/src/domain/policy';
import { interpretCapture } from '@/src/server/payments/paypal';
import type { CheckoutUrls, PaymentProvider } from '@/src/server/payments/provider';
import { ownedBy } from '@/src/server/session';

// The only module that creates orders or moves money. The agent reaches submitCart through its checkout tool;
// decideOrder is reachable only from the user's inbox route.

const STATUS = { ALLOW: 'READY', NEEDS_APPROVAL: 'NEEDS_APPROVAL', DENY: 'DENIED' } as const;
const DECIDABLE = ['READY', 'NEEDS_APPROVAL'];
type Result = { status: number; body: Record<string, unknown> };

const audit = (db: Pick<PrismaClient, 'auditLog'>, sessionId: string, action: string, outcome: string, detail: unknown) =>
  db.auditLog.create({ data: { sessionId, action, outcome, detail: JSON.stringify(detail) } });

export async function latestIntent(db: PrismaClient, sessionId: string) {
  return db.intent.findFirst({ where: { sessionId }, orderBy: { createdAt: 'desc' } });
}

export async function setIntent(db: PrismaClient, sessionId: string, intent: Intent) {
  const row = await db.intent.create({ data: { sessionId, ...intent } });
  await audit(db, sessionId, 'setIntent', 'SAVED', intent);
  return row;
}

// Stores the agent's proposal server-side and returns a preview evaluation. Nothing is ordered here.
export async function saveCart(db: PrismaClient, sessionId: string, cart: CartLine[]) {
  const intent = await latestIntent(db, sessionId);
  if (!intent) return { ok: false as const, error: 'No purchase intent yet. Ask the user to set budget, category and quantity in the form.' };
  await db.demoSession.update({ where: { id: sessionId }, data: { cartJson: JSON.stringify(cart) } });
  const { decision, reasons, lines, totalCents } = evaluateCart(intent, cart, await db.product.findMany());
  return { ok: true as const, preview: { decision, reasons, lines, totalCents } };
}

export async function submitCart(db: PrismaClient, sessionId: string) {
  const [session, intent] = await Promise.all([db.demoSession.findUniqueOrThrow({ where: { id: sessionId } }), latestIntent(db, sessionId)]);
  const cart = JSON.parse(session.cartJson) as CartLine[];
  if (!intent) return { ok: false as const, error: 'No purchase intent yet.' };
  if (cart.length === 0) return { ok: false as const, error: 'The cart is empty. Build a cart first.' };
  const evaluation = evaluateCart(intent, cart, await db.product.findMany());
  const status = STATUS[evaluation.decision];
  const order = await db.$transaction(async tx => {
    const row = await tx.order.create({ data: { sessionId, intentId: intent.id, status, cartJson: session.cartJson, totalCents: evaluation.totalCents, evaluationJson: JSON.stringify(evaluation) } });
    await audit(tx, sessionId, 'checkout', status, { orderId: row.id, reasons: evaluation.reasons });
    return row;
  });
  return { ok: true as const, orderId: order.id, status, decision: evaluation.decision, reasons: evaluation.reasons };
}

export async function listOrders(db: PrismaClient, sessionId: string) {
  const rows = await db.order.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, include: { intent: true } });
  return rows.map(({ evaluationJson, cartJson: _cart, intent, ...row }) => ({
    ...row,
    intent: { budgetCents: intent.budgetCents, category: intent.category, quantity: intent.quantity },
    evaluation: JSON.parse(evaluationJson) as Evaluation,
  }));
}

export async function decideOrder(db: PrismaClient, provider: PaymentProvider, sessionId: string, id: string, decision: 'APPROVED' | 'REJECTED', urls: CheckoutUrls): Promise<Result> {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id), include: { intent: true } });
  if (!order) return { status: 404, body: { error: 'Order not found.' } };
  if (order.status === 'DENIED') return { status: 409, body: { error: 'A denied cart cannot be approved. Change the cart or the purchase intent.' } };
  if (!DECIDABLE.includes(order.status)) return { status: 409, body: { error: 'This order was already decided.' } };
  // Conditional transition: of two concurrent decisions only one moves the row out of its current status.
  const claim = (status: string) => db.order.updateMany({ where: { ...ownedBy(sessionId, id), status: order.status }, data: { status, provider: decision === 'APPROVED' ? provider.kind : null } });

  if (decision === 'REJECTED') {
    if (!(await claim('REJECTED')).count) return { status: 409, body: { error: 'This order was already decided.' } };
    await audit(db, sessionId, 'humanReview', 'REJECTED', { orderId: id, captured: false });
    return { status: 200, body: { status: 'REJECTED' } };
  }

  // Re-check against the current catalog right before money moves. A cart that is now DENY or repriced is not paid.
  const recheck = evaluateCart(order.intent, JSON.parse(order.cartJson) as CartLine[], await db.product.findMany());
  if (recheck.decision === 'DENY' || recheck.totalCents !== order.totalCents) return { status: 409, body: { error: 'The catalog changed since this cart was proposed. Ask the agent for a new cart.' } };
  if (!(await claim('CAPTURE_PENDING')).count) return { status: 409, body: { error: 'This order was already decided.' } };
  await audit(db, sessionId, 'humanReview', 'APPROVED', { orderId: id, provider: provider.kind });

  let providerOrderId: string | null = null;
  let result: ReturnType<typeof interpretCapture>;
  try {
    const created = await provider.createOrder({ referenceId: order.id, currency: 'USD', unitCents: order.totalCents, quantity: 1, name: `TrustCart order ${order.id}`, totalCents: order.totalCents }, urls);
    const createdId = (created as { id?: unknown }).id;
    if (typeof createdId !== 'string') throw new Error('Provider returned no order ID');
    providerOrderId = createdId;
    result = interpretCapture(await provider.captureOrder(createdId), { referenceId: order.id, totalCents: order.totalCents, merchantId: provider.merchantId });
  } catch {
    result = { paid: false, reason: 'PROVIDER_ERROR' };
  }
  const status = result.paid ? 'PAID' : 'FAILED';
  await db.order.update({ where: { id }, data: { status, providerOrderId, captureId: result.paid ? result.captureId : null } });
  await audit(db, sessionId, 'capture', status, { orderId: id, provider: provider.kind, providerOrderId, ...result });
  return { status: 200, body: { status, provider: provider.kind, ...(result.paid ? { captureId: result.captureId } : { reason: result.reason }) } };
}
