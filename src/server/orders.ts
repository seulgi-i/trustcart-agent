import type { PrismaClient } from '@prisma/client';
import { evaluateCart, type CartLine, type Evaluation, type Intent } from '@/src/domain/policy';
import { approvalLink, checkProviderOrder, interpretCapture, PayPalError, type CaptureResult, type CheckoutOrder } from '@/src/server/payments/paypal';
import { checkoutUrls, type CheckoutUrls, type PaymentProvider } from '@/src/server/payments/provider';
import { ownedBy } from '@/src/server/session';

// The only module that creates orders or moves money. The agent reaches submitCart through its checkout tool;
// decideOrder is reachable only from the user's inbox route, capturePayment and cancelPayment only from the
// checkout return and cancel routes. Every payment step is a conditional status transition, so a step runs at
// most once per order however many requests race for it.

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

// The approval page must be PayPal's sandbox checkout, or for the mock our own return URL. Anything else is refused.
function allowedApprovalUrl(provider: PaymentProvider, href: string | null, urls: CheckoutUrls) {
  if (!href) return false;
  if (provider.kind === 'mock') return href === urls.returnUrl;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.host === 'www.sandbox.paypal.com';
  } catch { return false; }
}

// Approve (NEEDS_APPROVAL) or confirm (READY): creates the provider order for the server-priced total and hands
// back the buyer approval URL. No money moves here; capture happens only after the buyer returns.
export async function decideOrder(db: PrismaClient, provider: PaymentProvider, sessionId: string, id: string, decision: 'APPROVED' | 'REJECTED'): Promise<Result> {
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
  if (!(await claim('PAYMENT_CREATING')).count) return { status: 409, body: { error: 'This order was already decided.' } };
  await audit(db, sessionId, 'humanReview', 'APPROVED', { orderId: id, provider: provider.kind });

  // Amount comes only from the catalog re-check (unit price x quantity per line), never from the client.
  const checkout: CheckoutOrder = { referenceId: order.id, currency: 'USD', unitCents: recheck.totalCents, quantity: 1, name: `TrustCart order ${order.id}`, totalCents: recheck.totalCents };
  const urls = checkoutUrls(id);
  let created: { providerOrderId: string; approvalUrl: string } | { reason: string };
  try {
    const response = await provider.createOrder(checkout, urls);
    const providerOrderId = (response as { id?: unknown }).id;
    const approvalUrl = approvalLink(response);
    if (typeof providerOrderId !== 'string') created = { reason: 'NO_PROVIDER_ORDER_ID' };
    else if (!allowedApprovalUrl(provider, approvalUrl, urls)) created = { reason: 'APPROVAL_URL_REFUSED' };
    else created = { providerOrderId, approvalUrl: approvalUrl! };
  } catch (error) {
    created = { reason: error instanceof PayPalError ? error.code : 'PROVIDER_ERROR' };
  }

  const where = { ...ownedBy(sessionId, id), status: 'PAYMENT_CREATING' };
  if ('reason' in created) {
    await db.$transaction([
      db.order.updateMany({ where, data: { status: 'FAILED', failureReason: created.reason } }),
      audit(db, sessionId, 'createPayment', 'FAILED', { orderId: id, provider: provider.kind, reason: created.reason }),
    ]);
    return { status: 502, body: { status: 'FAILED', provider: provider.kind, reason: created.reason } };
  }
  await db.$transaction([
    db.order.updateMany({ where, data: { status: 'AWAITING_PAYMENT', providerOrderId: created.providerOrderId, approvalUrl: created.approvalUrl } }),
    audit(db, sessionId, 'createPayment', 'AWAITING_PAYMENT', { orderId: id, provider: provider.kind, providerOrderId: created.providerOrderId, totalCents: recheck.totalCents }),
  ]);
  return { status: 200, body: { status: 'AWAITING_PAYMENT', provider: provider.kind, approvalUrl: created.approvalUrl } };
}

const CAPTURE_UNKNOWN = 'CAPTURE_OUTCOME_UNKNOWN';
const CAPTURE_LEASE_MS = 30_000;
const paidBody =(order: { provider: string | null; captureId: string | null }) => ({ status: 'PAID', provider: order.provider, captureId: order.captureId });

// Buyer came back from the approval page. Captures only a session-owned AWAITING_PAYMENT order whose provider
// order, fetched fresh, is APPROVED for the stored amount, USD and our payee. A PAID order is returned as is.
// An order left in CAPTURING (a crash after PayPal answered, before our write) is recovered on retry: the same
// fresh GET records an earlier COMPLETED capture, or an APPROVED order is captured with the same
// PayPal-Request-Id, which PayPal deduplicates against any capture still in flight.
export async function capturePayment(db: PrismaClient, provider: PaymentProvider, sessionId: string, id: string): Promise<Result> {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id) });
  if (!order) return { status: 404, body: { error: 'Order not found.' } };
  if (order.status === 'PAID') return { status: 200, body: paidBody(order) };
  const recovering = order.status === 'CAPTURING';
  if ((order.status !== 'AWAITING_PAYMENT' && !recovering) || !order.providerOrderId) return { status: 409, body: { error: 'This order is not awaiting payment.', status: order.status } };
  if (order.provider !== provider.kind) return { status: 409, body: { error: 'The payment provider changed since this order was created.', status: order.status } };

  const stateNow = async (): Promise<Result> => {
    const now = await db.order.findFirstOrThrow({ where: ownedBy(sessionId, id) });
    return now.status === 'PAID' ? { status: 200, body: paidBody(now) } : { status: 409, body: { error: 'Payment is already being processed.', status: now.status } };
  };
  // A recent CAPTURING row is most likely a capture still in flight, so it is left alone. A stale one is re-claimed
  // conditionally on its updatedAt, so of several concurrent retries only one recovers it.
  if (recovering && Date.now() - order.updatedAt.getTime() < CAPTURE_LEASE_MS) return stateNow();
  const claimed = await db.order.updateMany({
    where: { ...ownedBy(sessionId, id), ...(recovering ? { status: 'CAPTURING', updatedAt: order.updatedAt } : { status: 'AWAITING_PAYMENT' }) },
    data: { status: 'CAPTURING', updatedAt: new Date() },
  });
  if (!claimed.count) return stateNow();

  const providerOrderId = order.providerOrderId;
  const expected = { providerOrderId, referenceId: order.id, totalCents: order.totalCents, merchantId: provider.merchantId };
  let result: CaptureResult;
  try {
    const current = await provider.getOrder(providerOrderId);
    const check = checkProviderOrder(current, expected);
    if (!check.ok) result = { paid: false, reason: check.reason, status: check.status };
    // Already captured (e.g. a crash after capture, before our write): record it, never capture twice.
    else if (check.status === 'COMPLETED') result = interpretCapture(current, expected);
    else result = interpretCapture(await provider.captureOrder(providerOrderId), expected);
  } catch (error) {
    // The capture may have happened. Put the order back so a retry re-reads it; the retry reuses the same
    // PayPal-Request-Id and the GET above records an earlier capture instead of repeating it.
    if (error instanceof PayPalError && error.outcomeUnknown) {
      await db.$transaction([
        db.order.updateMany({ where: { ...ownedBy(sessionId, id), status: 'CAPTURING' }, data: { status: 'AWAITING_PAYMENT', failureReason: CAPTURE_UNKNOWN } }),
        audit(db, sessionId, 'capture', 'UNKNOWN', { orderId: id, provider: provider.kind, providerOrderId, reason: error.code }),
      ]);
      return { status: 503, body: { error: 'The payment provider did not answer. Try again; you will not be charged twice.', status: 'AWAITING_PAYMENT' } };
    }
    result = { paid: false, reason: error instanceof PayPalError ? error.code : 'PROVIDER_ERROR' };
  }

  const status = result.paid ? 'PAID' : 'FAILED';
  const recorded = await db.$transaction(async tx => {
    const moved = await tx.order.updateMany({ where: { ...ownedBy(sessionId, id), status: 'CAPTURING' }, data: result.paid ? { status, captureId: result.captureId, failureReason: null } : { status, failureReason: result.reason } });
    if (moved.count) await audit(tx, sessionId, 'capture', status, { orderId: id, provider: provider.kind, providerOrderId, recovered: recovering, ...result });
    return moved.count > 0;
  });
  if (!recorded) return stateNow();
  return { status: 200, body: result.paid ? { status, provider: provider.kind, captureId: result.captureId } : { status, provider: provider.kind, reason: result.reason } };
}

// Buyer cancelled on the approval page. No provider call: an uncaptured PayPal order simply expires. An order
// whose capture outcome is unknown cannot be cancelled, since money may have moved; it must be retried instead.
export async function cancelPayment(db: PrismaClient, sessionId: string, id: string): Promise<Result> {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id) });
  if (!order) return { status: 404, body: { error: 'Order not found.' } };
  if (order.status === 'CANCELLED') return { status: 200, body: { status: 'CANCELLED' } };
  const cancelled = await db.$transaction(async tx => {
    const moved = await tx.order.updateMany({ where: { ...ownedBy(sessionId, id), status: 'AWAITING_PAYMENT', failureReason: null }, data: { status: 'CANCELLED', failureReason: 'BUYER_CANCELLED' } });
    if (moved.count) await audit(tx, sessionId, 'cancelPayment', 'CANCELLED', { orderId: id, providerOrderId: order.providerOrderId, captured: false });
    return moved.count > 0;
  });
  if (!cancelled) return { status: 409, body: { error: 'Only an order awaiting payment can be cancelled.', status: order.status } };
  return { status: 200, body: { status: 'CANCELLED' } };
}
