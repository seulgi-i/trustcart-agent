import type { Prisma, PrismaClient, SessionPolicy as PolicyRow } from '@prisma/client';
import { layer1Limits, MAX_WINDOW_MINUTES, MONEY_MOVING, startOfUtcMonth, type Layer1Limits } from '@/src/domain/layer1';
import { buildMandatePayload, merchantLabel } from '@/src/domain/mandate';
import { describeReason } from '@/src/domain/rule-labels';
import { evaluateCart, type CartLine, type Evaluation, type Intent, type PaymentRecord } from '@/src/domain/policy';
import { classifyPolicyChange, cooldownEnds, defaultSpendingPolicy, makeSpendingPolicySchema, pendingIsDue, type SpendingPolicy } from '@/src/domain/spending-policy';
import type { RuntimeProduct } from '@/src/server/catalog';
import { approvalLink, checkProviderOrder, interpretCapture, PayPalError, type CaptureResult, type CheckoutOrder } from '@/src/server/payments/paypal';
import { checkoutUrls, type CheckoutUrls, type PaymentProvider } from '@/src/server/payments/provider';
import { mandateSigner, signMandate, type MandateSigner } from '@/src/server/mandate';
import { ownedBy } from '@/src/server/session';

// The only module that creates orders or moves money. The agent reaches submitCart through its checkout tool;
// decideOrder is reachable only from the user's inbox route, capturePayment and cancelPayment only from the
// checkout return and cancel routes, schedulePrecharge/cancelPrecharge only from the pre-charge notice routes, and
// setPolicy only from the user's /policy route. Every payment step is a conditional status transition, so a step runs at
// most once per order however many requests race for it.

const STATUS = { ALLOW: 'READY', NEEDS_APPROVAL: 'NEEDS_APPROVAL', DENY: 'DENIED' } as const;
const DECIDABLE = ['READY', 'NEEDS_APPROVAL'];
type Result = { status: number; body: Record<string, unknown> };

export const audit = (db: Pick<PrismaClient, 'auditLog'>,sessionId: string, action: string, outcome: string, detail: unknown) =>
  db.auditLog.create({ data: { sessionId, action, outcome, detail: JSON.stringify(detail) } });

export async function latestIntent(db: PrismaClient, sessionId: string) {
  return db.intent.findFirst({ where: { sessionId }, orderBy: { createdAt: 'desc' } });
}

export async function setIntent(db: PrismaClient, sessionId: string, intent: Intent) {
  const row = await db.intent.create({ data: { sessionId, ...intent } });
  await audit(db, sessionId, 'setIntent', 'SAVED', intent);
  return row;
}

const catalogCategories = (catalog: Pick<RuntimeProduct, 'category'>[]) => [...new Set(catalog.map(p => p.category))].sort();

// --- Layer 2: the session's spending policy -------------------------------------------------------------------------

type PolicyColumns = Omit<PolicyRow, 'sessionId' | 'updatedAt' | 'pendingJson' | 'pendingEffectiveAt'>;
const toColumns = (p: SpendingPolicy): PolicyColumns => ({
  perOrderMaxCents: p.perOrderMaxCents, dailyMaxCents: p.dailyMaxCents, allowedCategories: p.allowedCategories,
  perCategoryMaxJson: JSON.stringify(p.perCategoryMaxCents), requireApprovalAboveCents: p.requireApprovalAboveCents,
  allowedStartHour: p.allowedHours.startHour, allowedEndHour: p.allowedHours.endHour, allowedWeekdays: p.allowedWeekdays,
  timezone: p.timezone, prechargeDelaySeconds: p.prechargeDelaySeconds,
});
const fromRow = (row: PolicyRow): SpendingPolicy => ({
  perOrderMaxCents: row.perOrderMaxCents, dailyMaxCents: row.dailyMaxCents, allowedCategories: row.allowedCategories,
  perCategoryMaxCents: JSON.parse(row.perCategoryMaxJson) as Record<string, number>, requireApprovalAboveCents: row.requireApprovalAboveCents,
  allowedHours: { startHour: row.allowedStartHour, endHour: row.allowedEndHour }, allowedWeekdays: row.allowedWeekdays,
  timezone: row.timezone, prechargeDelaySeconds: row.prechargeDelaySeconds,
});

// The policy is read with the client or inside an open transaction (decideOrder reads it under its approval lock).
type Client = PrismaClient | Prisma.TransactionClient;
const inTransaction = <T>(db: Client, fn: (tx: Prisma.TransactionClient) => Promise<T>) => '$transaction' in db ? db.$transaction(fn) : fn(db);

// Lazy cool-down: the first read at or after pendingEffectiveAt promotes the pending policy to the effective columns
// (no cron). Conditional on the same pendingEffectiveAt, so concurrent reads promote once. A pending policy that no
// longer fits the current Layer-1 limits is dropped instead.
async function promotePending(db: Client, row: PolicyRow, l1: Layer1Limits) {
  const parsed = makeSpendingPolicySchema(l1).safeParse(JSON.parse(row.pendingJson ?? 'null'));
  const clear = { pendingJson: null, pendingEffectiveAt: null };
  await inTransaction(db, async tx => {
    const moved = await tx.sessionPolicy.updateMany({ where: { sessionId: row.sessionId, pendingEffectiveAt: row.pendingEffectiveAt }, data: parsed.success ? { ...toColumns(parsed.data), ...clear } : clear });
    if (!moved.count) return;
    if (parsed.success) await audit(tx, row.sessionId, 'setPolicy', 'PROMOTED', { policy: parsed.data, scheduledFor: row.pendingEffectiveAt });
    else await audit(tx, row.sessionId, 'setPolicy', 'DROPPED', { reason: 'Pending policy no longer fits the Layer-1 limits.', scheduledFor: row.pendingEffectiveAt });
  });
  return db.sessionPolicy.findUniqueOrThrow({ where: { sessionId: row.sessionId } });
}

// The session's effective spending policy (defaults over the catalog categories when none was saved) and any
// pending loosening still in its cool-down.
export async function getPolicy(db: PrismaClient, sessionId: string, catalog?: Pick<RuntimeProduct, 'category'>[], now = new Date(), l1 = layer1Limits()) {
  const { row: _row, ...state } = await loadPolicy(db, sessionId, catalog, now, l1);
  return state;
}

// getPolicy plus the stored row it was read from (null for defaults), which setPolicy uses as its concurrency check.
async function loadPolicy(db: Client, sessionId: string, catalog: Pick<RuntimeProduct, 'category'>[] | undefined, now: Date, l1: Layer1Limits) {
  const [found, products] = await Promise.all([
    db.sessionPolicy.findUnique({ where: { sessionId } }),
    catalog ?? db.product.findMany({ distinct: ['category'], select: { category: true } }),
  ]);
  const categories = catalogCategories(products);
  if (!found) return { policy: defaultSpendingPolicy(categories, l1), pending: null, isDefault: true, categories, row: null };
  const row = pendingIsDue(found.pendingEffectiveAt, now) ? await promotePending(db, found, l1) : found;
  const policy = fromRow(row);
  const requested = row.pendingJson ? JSON.parse(row.pendingJson) as SpendingPolicy : null;
  const pending = requested && row.pendingEffectiveAt
    ? { policy: requested, effectiveAt: row.pendingEffectiveAt, loosenedFields: classifyPolicyChange(policy, requested).loosenedFields }
    : null;
  return { policy, pending, isDefault: false, categories, row };
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map(i => `${i.path.map(String).join('.') || 'policy'}: ${i.message}`);

// Only the user's /policy route calls this; the agent has no tool that reaches it. Validated strictly against the
// Layer-1 limits, categories must exist in the catalog, and every change is audited. Compared with the effective
// policy: tightened fields apply now (APPLIED); loosened fields are held for 24 h as a pending policy (PENDING) and
// promoted by getPolicy once due. Saving again replaces any pending policy and restarts its clock.
// The change is classified against the row as read, and the write is a compare-and-set on that row (updatedAt and
// pendingEffectiveAt; no row yet = insert only if still absent). If another save or a promotion changed it in between,
// nothing is written or audited and the caller gets 409, so a stale loosening cannot overwrite a newer tightening.
export async function setPolicy(db: PrismaClient, sessionId: string, input: unknown, now = new Date()): Promise<Result> {
  const l1 = layer1Limits();
  const parsed = makeSpendingPolicySchema(l1).safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: 'Invalid policy.', issues: issues(parsed.error) } };
  const requested = parsed.data;
  const current = await loadPolicy(db, sessionId, undefined, now, l1);
  const unknown = requested.allowedCategories.filter(c => !current.categories.includes(c));
  if (unknown.length) return { status: 400, body: { error: `Unknown category: ${unknown.join(', ')}.` } };

  const { immediate, tightenedFields, loosenedFields } = classifyPolicyChange(current.policy, requested);
  const effectiveAt = loosenedFields.length ? cooldownEnds(now) : null;
  const pendingCols = { pendingJson: effectiveAt ? JSON.stringify(requested) : null, pendingEffectiveAt: effectiveAt };
  const seen = current.row;
  const saved = await db.$transaction(async tx => {
    const data = { ...toColumns(immediate), ...pendingCols };
    const written = seen
      // updatedAt is bumped strictly past the row as read, so two saves within one millisecond still differ.
      ? await tx.sessionPolicy.updateMany({
        where: { sessionId, updatedAt: seen.updatedAt, pendingEffectiveAt: seen.pendingEffectiveAt },
        data: { ...data, updatedAt: new Date(Math.max(Date.now(), seen.updatedAt.getTime() + 1)) },
      })
      : await tx.sessionPolicy.createMany({ data: [{ sessionId, ...data }], skipDuplicates: true });
    if (!written.count) return false;
    if (tightenedFields.length || !effectiveAt) await audit(tx, sessionId, 'setPolicy', 'APPLIED', { policy: immediate, tightenedFields, clearedPending: !effectiveAt && current.pending !== null });
    if (effectiveAt) await audit(tx, sessionId, 'setPolicy', 'PENDING', { requested, effectiveAt, loosenedFields });
    return true;
  });
  if (!saved) return { status: 409, body: { error: 'The policy changed while you were saving it. Reload the page and try again.' } };
  return { status: 200, body: {
    ok: true, outcome: effectiveAt ? 'PENDING' : 'APPLIED', policy: immediate,
    pending: effectiveAt ? { policy: requested, effectiveAt, loosenedFields } : null, tightenedFields, loosenedFields,
  } };
}

// --- Checkout evaluation (Layer 1 + Layer 2) ------------------------------------------------------------------------

// This session's payments that count for velocity, split-payment, duplicate and daily/monthly caps: orders in a
// MONEY_MOVING status whose last payment step is in the current UTC month or the longest rule window.
export async function paymentHistory(db: Pick<PrismaClient, 'order'>, sessionId: string, now: Date, excludeOrderId?: string): Promise<PaymentRecord[]> {
  const since = new Date(Math.min(startOfUtcMonth(now).getTime(), now.getTime() - MAX_WINDOW_MINUTES * 60_000));
  const rows = await db.order.findMany({
    where: { sessionId, status: { in: [...MONEY_MOVING] }, updatedAt: { gte: since }, ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}) },
    select: { id: true, status: true, totalCents: true, updatedAt: true, evaluationJson: true },
  });
  return rows.map(r => ({
    orderId: r.id, status: r.status, totalCents: r.totalCents, at: r.updatedAt,
    lines: (JSON.parse(r.evaluationJson) as Evaluation).lines.map(({ productId, seller, quantity, subtotalCents }) => ({ productId, seller, quantity, subtotalCents })),
  }));
}

// The single evaluation used for the cart preview (saveCart), order creation (submitCart) and the re-check right
// before the payment is created (decideOrder), so a cart cannot pass at preview and slip past a rule at payment time.
// Everything pure lives in evaluateCart; this only loads the effective policy and the payment history.
export async function evaluateCheckout(db: PrismaClient, sessionId: string, intent: Intent, cart: CartLine[], catalog: RuntimeProduct[], now = new Date(), excludeOrderId?: string) {
  const layer1 = layer1Limits();
  const [{ policy }, history] = await Promise.all([getPolicy(db, sessionId, catalog, now, layer1), paymentHistory(db, sessionId, now, excludeOrderId)]);
  return evaluateCart(intent, cart, catalog, { policy, history, now, layer1 });
}

// Stores the agent's proposal server-side and returns a preview evaluation. Nothing is ordered here.
export async function saveCart(db: PrismaClient, sessionId: string, cart: CartLine[], now = new Date()) {
  const intent = await latestIntent(db, sessionId);
  if (!intent) return { ok: false as const, error: 'No purchase intent yet. Ask the user to set budget, category and quantity in the form.' };
  await db.demoSession.update({ where: { id: sessionId }, data: { cartJson: JSON.stringify(cart) } });
  const catalog = await db.product.findMany();
  const { decision, reasons, lines, totalCents } = await evaluateCheckout(db, sessionId, intent, cart, catalog, now);
  return { ok: true as const, preview: { decision, reasons, lines, totalCents } };
}

export async function submitCart(db: PrismaClient, sessionId: string, now = new Date()) {
  const [session, intent] = await Promise.all([db.demoSession.findUniqueOrThrow({ where: { id: sessionId } }), latestIntent(db, sessionId)]);
  const cart = JSON.parse(session.cartJson) as CartLine[];
  if (!intent) return { ok: false as const, error: 'No purchase intent yet.' };
  if (cart.length === 0) return { ok: false as const, error: 'The cart is empty. Build a cart first.' };
  const catalog = await db.product.findMany();
  const evaluation = await evaluateCheckout(db, sessionId, intent, cart, catalog, now);
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

// What the payment decision was made on: the approval re-check's evaluation (priced lines, decision, reasons, scan),
// the effective spending policy and the Layer-1 limits it ran under. Stored with the PAYMENT_CREATING claim; the
// mandate is built from it at capture, so a policy change between approval and capture never rewrites it.
export type PaymentSnapshot = { evaluation: Evaluation; policy: SpendingPolicy; layer1: Layer1Limits; decidedAt: string };

// Approve (NEEDS_APPROVAL) or confirm (READY): creates the provider order for the server-priced total and hands
// back the buyer approval URL. No money moves here; capture happens only after the buyer returns.
// hooks.onLocked is a test seam only: it runs right after the approval lock is taken, so a test can hold one approval
// inside the locked section while another waits on the lock.
export async function decideOrder(db: PrismaClient, provider: PaymentProvider, sessionId: string, id: string, decision: 'APPROVED' | 'REJECTED', now = new Date(), hooks: { onLocked?: () => Promise<void> } = {}): Promise<Result> {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id), include: { intent: true } });
  if (!order) return { status: 404, body: { error: 'Order not found.' } };
  if (order.status === 'DENIED') return { status: 409, body: { error: 'A denied cart cannot be approved. Change the cart or the purchase intent.' } };
  if (!DECIDABLE.includes(order.status)) return { status: 409, body: { error: 'This order was already decided.' } };
  // Conditional transition: of two concurrent decisions only one moves the row out of its current status.
  const claim = (status: string, client: Pick<PrismaClient, 'order'> = db, snapshot?: PaymentSnapshot) => client.order.updateMany({
    where: { ...ownedBy(sessionId, id), status: order.status },
    data: { status, provider: decision === 'APPROVED' ? provider.kind : null, ...(snapshot ? { paymentSnapshotJson: JSON.stringify(snapshot) } : {}) },
  });

  if (decision === 'REJECTED') {
    if (!(await claim('REJECTED')).count) return { status: 409, body: { error: 'This order was already decided.' } };
    await audit(db, sessionId, 'humanReview', 'REJECTED', { orderId: id, captured: false });
    return { status: 200, body: { status: 'REJECTED' } };
  }

  // Re-check against the current catalog, the Layer-1 system limits (velocity, split payment, duplicate, daily and
  // monthly caps over this session's other payments) and the effective spending policy right before money moves.
  // A cart that is now DENY or repriced is not paid.
  // The policy and payment-history reads and the claim run in one transaction under a per-session advisory lock, so
  // concurrent approvals in a session are serialized: the second one sees the first as PAYMENT_CREATING in its history
  // and cannot also pass velocity, split, duplicate or the daily/monthly caps. The policy is read after the lock, so a
  // tightening committed before then is the one evaluated. Nothing is claimed unless the re-check passes.
  const catalog = await db.product.findMany();
  const layer1 = layer1Limits();
  const gate = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`decideOrder:${sessionId}`}))`;
    await hooks.onLocked?.();
    const { policy } = await loadPolicy(tx, sessionId, catalog, now, layer1);
    const history = await paymentHistory(tx, sessionId, now, id);
    const recheck = evaluateCart(order.intent, JSON.parse(order.cartJson) as CartLine[], catalog, { policy, history, now, layer1 });
    if (recheck.totalCents !== order.totalCents || recheck.decision === 'DENY') return { recheck, urls: null };
    // Built before the claim: a missing APP_BASE_URL must fail here, not leave the order stuck in PAYMENT_CREATING.
    const urls = checkoutUrls(id);
    if (!(await claim('PAYMENT_CREATING', tx, { evaluation: recheck, policy, layer1, decidedAt: now.toISOString() })).count) return { recheck, urls: null };
    await audit(tx, sessionId, 'humanReview', 'APPROVED', { orderId: id, provider: provider.kind });
    return { recheck, urls };
  });
  const { recheck } = gate;
  if (recheck.totalCents !== order.totalCents) return { status: 409, body: { error: 'The catalog changed since this cart was proposed. Ask the agent for a new cart.' } };
  if (recheck.decision === 'DENY') {
    const reasons = recheck.reasons.filter(r => r.outcome === 'DENY');
    await audit(db, sessionId, 'humanReview', 'BLOCKED', { orderId: id, reasons });
    return { status: 409, body: { error: `This cart no longer passes the checks. ${reasons.map(r => `${describeReason(r).title}: ${r.message}`).join(' ')}`, reasons } };
  }
  const { urls } = gate;
  if (!urls) return { status: 409, body: { error: 'This order was already decided.' } };

  // Amount comes only from the catalog re-check (unit price x quantity per line), never from the client.
  const checkout: CheckoutOrder = { referenceId: order.id, currency: 'USD', unitCents: recheck.totalCents, quantity: 1, name: `TrustCart order ${order.id}`, totalCents: recheck.totalCents };
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

// Pre-charge notice: after the buyer returns, the charge is announced and capture waits the user's effective
// prechargeDelaySeconds (Layer 2, 30-600 s, default 60), during which the buyer can cancel. The wait is enforced by
// capturePayment from the stored captureScheduledAt and the delay in force at capture time.
export async function prechargeDelaySeconds(db: PrismaClient, sessionId: string, now = new Date()) {
  return (await getPolicy(db, sessionId, [], now)).policy.prechargeDelaySeconds;
}
const captureDueMs = (scheduledAt: Date, delaySeconds: number) => scheduledAt.getTime() + delaySeconds * 1000;
const secondsUntil = (ms: number, now: Date) => Math.max(0, Math.ceil((ms - now.getTime()) / 1000));

// Buyer is back from the approval page. Sets captureScheduledAt once (a reload keeps the original time) and returns
// what the notice shows. Item names are seller-written; the UI renders them as plain text.
export async function schedulePrecharge(db: PrismaClient, sessionId: string, id: string, now = new Date()): Promise<Result> {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id) });
  if (!order) return { status: 404, body: { error: 'Order not found.' } };
  if (order.status === 'PAID') return { status: 200, body: paidBody(order) };
  if (order.status !== 'AWAITING_PAYMENT' || order.captureCanceled) return { status: 409, body: { error: 'This order is not awaiting payment.', status: order.status } };
  const delaySeconds = await prechargeDelaySeconds(db, sessionId, now);
  if (!order.captureScheduledAt) {
    await db.$transaction(async tx => {
      const moved = await tx.order.updateMany({ where: { ...ownedBy(sessionId, id), status: 'AWAITING_PAYMENT', captureCanceled: false, captureScheduledAt: null }, data: { captureScheduledAt: now } });
      if (moved.count) await audit(tx, sessionId, 'prechargeSchedule', 'SCHEDULED', { orderId: id, totalCents: order.totalCents, delaySeconds, captureAt: new Date(now.getTime() + delaySeconds * 1000).toISOString() });
    });
  }
  // Re-read: a concurrent request may have scheduled or cancelled it first.
  const current = await db.order.findFirstOrThrow({ where: ownedBy(sessionId, id) });
  if (current.status !== 'AWAITING_PAYMENT' || current.captureCanceled || !current.captureScheduledAt) return { status: 409, body: { error: 'This order is not awaiting payment.', status: current.status } };
  const lines = (JSON.parse(current.evaluationJson) as Evaluation).lines;
  const due = captureDueMs(current.captureScheduledAt, delaySeconds);
  return { status: 200, body: {
    status: 'AWAITING_PAYMENT', orderId: id, totalCents: current.totalCents,
    merchant: merchantLabel(lines, current.provider),
    items: lines.map(l => `${l.quantity} × ${l.name}`),
    delaySeconds, scheduledAt: current.captureScheduledAt.toISOString(), captureAt: new Date(due).toISOString(), remainingSeconds: secondsUntil(due, now),
  } };
}

// Cancel from the pre-charge notice. Marks the order so capture refuses it for good and closes it as CANCELLED. No
// provider call: an uncaptured PayPal order simply expires. Like cancelPayment, an order whose capture outcome is
// unknown cannot be cancelled.
export async function cancelPrecharge(db: PrismaClient, sessionId: string, id: string): Promise<Result> {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id) });
  if (!order) return { status: 404, body: { error: 'Order not found.' } };
  if (order.captureCanceled) return { status: 200, body: { status: order.status, canceled: true } };
  const cancelled = await db.$transaction(async tx => {
    const moved = await tx.order.updateMany({
      where: { ...ownedBy(sessionId, id), status: 'AWAITING_PAYMENT', failureReason: null, captureCanceled: false },
      data: { captureCanceled: true, status: 'CANCELLED', failureReason: 'PRECHARGE_CANCELLED' },
    });
    if (moved.count) await audit(tx, sessionId, 'prechargeCancel', 'CANCELLED', { orderId: id, providerOrderId: order.providerOrderId, captured: false });
    return moved.count > 0;
  });
  if (!cancelled) return { status: 409, body: { error: 'Only an order awaiting payment can be cancelled.', status: order.status } };
  return { status: 200, body: { status: 'CANCELLED', canceled: true } };
}

// Buyer came back from the approval page. Captures only a session-owned AWAITING_PAYMENT order whose provider
// order, fetched fresh, is APPROVED for the stored amount, USD and our payee. A PAID order is returned as is.
// An order left in CAPTURING (a crash after PayPal answered, before our write) is recovered on retry: the same
// fresh GET records an earlier COMPLETED capture, or an APPROVED order is captured with the same
// PayPal-Request-Id, which PayPal deduplicates against any capture still in flight.
// The pre-charge notice must have been shown (captureScheduledAt set), the effective policy's delay must have passed
// on the server clock, and the buyer must not have cancelled it; otherwise 409 before any provider call.
// A PAID result is written together with a signed intent mandate (src/domain/mandate.ts). The signing key is loaded
// before anything is claimed, so a production server without MANDATE_SIGNING_KEY throws here and never captures.
export async function capturePayment(db: PrismaClient, provider: PaymentProvider, sessionId: string, id: string, now = new Date(), signer: () => MandateSigner = mandateSigner): Promise<Result> {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id), include: { intent: true } });
  if (!order) return { status: 404, body: { error: 'Order not found.' } };
  if (order.status === 'PAID') return { status: 200, body: paidBody(order) };
  if (order.captureCanceled) return { status: 409, body: { error: 'This payment was cancelled before capture.', status: order.status } };
  const recovering = order.status === 'CAPTURING';
  if ((order.status !== 'AWAITING_PAYMENT' && !recovering) || !order.providerOrderId) return { status: 409, body: { error: 'This order is not awaiting payment.', status: order.status } };
  if (order.provider !== provider.kind) return { status: 409, body: { error: 'The payment provider changed since this order was created.', status: order.status } };
  if (!order.captureScheduledAt) return { status: 409, body: { error: 'The payment has not been scheduled yet. Open the pre-charge notice first.', status: order.status } };
  const due = captureDueMs(order.captureScheduledAt, await prechargeDelaySeconds(db, sessionId, now));
  if (now.getTime() < due) return { status: 409, body: { error: 'The pre-charge notice period has not ended yet.', status: order.status, retryAfterSeconds: secondsUntil(due, now) } };
  // An order approved before decision snapshots existed is refused before any provider call. One already left
  // CAPTURING (money may have moved) is still recorded, its mandate falling back to the stored evaluation and the
  // policy read now, marked policy.source 'reconstructed_at_recovery' so it is never shown as the payment-time policy.
  const snapshot = order.paymentSnapshotJson ? JSON.parse(order.paymentSnapshotJson) as PaymentSnapshot : null;
  if (!snapshot && !recovering) return { status: 409, body: { error: 'This order has no payment decision on record. Ask the agent for a new cart.', status: order.status } };
  const mandateKey = signer();

  const stateNow = async (): Promise<Result> => {
    const now = await db.order.findFirstOrThrow({ where: ownedBy(sessionId, id) });
    return now.status === 'PAID' ? { status: 200, body: paidBody(now) } : { status: 409, body: { error: 'Payment is already being processed.', status: now.status } };
  };
  // A recent CAPTURING row is most likely a capture still in flight, so it is left alone. A stale one is re-claimed
  // conditionally on its updatedAt, so of several concurrent retries only one recovers it.
  if (recovering && now.getTime() - order.updatedAt.getTime() < CAPTURE_LEASE_MS) return stateNow();
  // captureCanceled is part of the claim, so a cancel racing this capture wins or loses atomically.
  const claimed = await db.order.updateMany({
    where: { ...ownedBy(sessionId, id), captureCanceled: false, ...(recovering ? { status: 'CAPTURING', updatedAt: order.updatedAt } : { status: 'AWAITING_PAYMENT' }) },
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
  // Signed before the write and stored in the same transaction: an order is never PAID without its mandate. If this
  // throws, the order stays CAPTURING and a retry recovers it from the provider's COMPLETED capture.
  // The cart, decision, reasons and policy come from the approval snapshot: what the payment was actually decided on.
  const basis: Omit<PaymentSnapshot, 'decidedAt'> | null = !result.paid ? null : snapshot
    ?? { evaluation: JSON.parse(order.evaluationJson) as Evaluation, policy: (await getPolicy(db, sessionId, undefined, now)).policy, layer1: layer1Limits() };
  const mandate = result.paid && basis ? signMandate(mandateKey, buildMandatePayload({
    policySource: snapshot ? 'payment_time_snapshot' : 'reconstructed_at_recovery',
    order: { ...order, provider: provider.kind, providerOrderId, evaluation: basis.evaluation },
    intent: order.intent, captureId: result.captureId, capturedCents: result.amountCents,
    policy: basis.policy, layer1: basis.layer1, capturedAt: now,
  })) : null;
  const recorded = await db.$transaction(async tx => {
    const moved = await tx.order.updateMany({ where: { ...ownedBy(sessionId, id), status: 'CAPTURING' }, data: result.paid ? { status, captureId: result.captureId, failureReason: null } : { status, failureReason: result.reason } });
    if (!moved.count) return false;
    await audit(tx, sessionId, 'capture', status, { orderId: id, provider: provider.kind, providerOrderId, recovered: recovering, ...result });
    if (mandate) {
      await tx.mandate.create({ data: { orderId: id, ...mandate } });
      await audit(tx, sessionId, 'mandate', 'ISSUED', { orderId: id, publicKeyFingerprint: mandate.publicKeyFingerprint });
    }
    return true;
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
