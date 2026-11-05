import type { Mandate, Order, Prisma, PrismaClient, RefundRequest } from '@prisma/client';
import { z } from 'zod';
import type { MandatePayload } from '@/src/domain/mandate';
import { diffBilling, MISMATCH_SCENARIOS, overchargeCents, simulateBilling, type DiffEntry } from '@/src/domain/mismatch';
import { mandateSigner, verifyMandate, type MandateSigner } from '@/src/server/mandate';
import { audit } from '@/src/server/orders';
import { interpretRefund, PayPalError, type RefundResult } from '@/src/server/payments/paypal';
import type { PaymentProvider } from '@/src/server/payments/provider';
import { ownedBy } from '@/src/server/session';

// Post-payment protection for paid orders: the signed mandate view and its verification, the (demo) billing check
// against the mandate, refund drafts with evidence, and the refund itself. Every lookup is session-owned, so another
// session's order or refund behaves like a missing one (404).

type Result = { status: number; body: Record<string, unknown> };
const notFound: Result = { status: 404, body: { error: 'Order not found.' } };

// Refund amounts in these statuses are committed: money moved or may be moving. FAILED releases its amount.
const COMMITTED = ['REFUNDING', 'REFUNDED', 'PENDING'];
const REFUND_UNKNOWN = 'REFUND_OUTCOME_UNKNOWN';
// A REFUNDING row older than this with no outcome is treated as abandoned (e.g. the process died after PayPal
// accepted the refund, before our write) and can be retried, like a stale CAPTURING order.
export const REFUND_LEASE_MS = 30_000;

// A submitted refund can be retried by its owner when the provider's answer was lost (REFUND_OUTCOME_UNKNOWN) or the
// request was left in flight past the lease. The retry reuses the stored mode, amount and idempotency key, so PayPal
// returns the original refund instead of making a second one.
export const refundRetryable = (r: Pick<RefundRequest, 'status' | 'failureReason' | 'amountCents' | 'mode' | 'updatedAt'>, now = new Date()) =>
  r.status === 'REFUNDING' && r.amountCents !== null && r.mode !== null
  && (r.failureReason === REFUND_UNKNOWN || now.getTime() - r.updatedAt.getTime() >= REFUND_LEASE_MS);

export type RefundEvidence = { mandate: { payload: string; signature: string; publicKeyFingerprint: string }; billing: MandatePayload['cart']; diff: DiffEntry[] };

const refundedCents = (refunds: Pick<RefundRequest, 'status' | 'amountCents'>[]) =>
  refunds.filter(r => COMMITTED.includes(r.status)).reduce((sum, r) => sum + (r.amountCents ?? 0), 0);
const refundableCents = (order: Pick<Order, 'status' | 'captureId' | 'totalCents'>, refunds: Pick<RefundRequest, 'status' | 'amountCents'>[]) =>
  order.status === 'PAID' && order.captureId ? Math.max(0, order.totalCents - refundedCents(refunds)) : 0;

export function refundView(r: RefundRequest, now = new Date()) {
  const evidence = JSON.parse(r.evidenceJson) as RefundEvidence;
  return {
    id: r.id, scenario: r.scenario, status: r.status, diff: evidence.diff, billing: evidence.billing,
    suggestedCents: r.suggestedCents, capturedCents: r.capturedCents, mode: r.mode, amountCents: r.amountCents,
    providerRefundId: r.providerRefundId, providerStatus: r.providerStatus, failureReason: r.failureReason,
    retryable: refundRetryable(r, now), createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export const mandateView = (m: Mandate) => ({ payload: JSON.parse(m.payload) as MandatePayload, signature: m.signature, publicKeyFingerprint: m.publicKeyFingerprint, createdAt: m.createdAt });

function loadOrder(db: PrismaClient, sessionId: string, id: string) {
  return db.order.findFirst({ where: ownedBy(sessionId, id), include: { mandate: true, refundRequests: { orderBy: { createdAt: 'asc' } } } });
}

export async function getOrderProtection(db: PrismaClient, sessionId: string, id: string, now = new Date()): Promise<Result> {
  const order = await loadOrder(db, sessionId, id);
  if (!order) return notFound;
  return { status: 200, body: {
    order: { id: order.id, status: order.status, totalCents: order.totalCents, provider: order.provider, providerOrderId: order.providerOrderId, captureId: order.captureId, createdAt: order.createdAt },
    mandate: order.mandate ? mandateView(order.mandate) : null,
    refundRequests: order.refundRequests.map(r => refundView(r, now)),
    refundedCents: refundedCents(order.refundRequests),
    refundableCents: refundableCents(order, order.refundRequests),
  } };
}

export async function verifyOrderMandate(db: PrismaClient, sessionId: string, id: string, signer: () => MandateSigner = mandateSigner): Promise<Result> {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id), include: { mandate: true } });
  if (!order) return notFound;
  if (!order.mandate) return { status: 404, body: { error: 'This order has no mandate.' } };
  return { status: 200, body: { orderId: id, ...verifyMandate(order.mandate, signer(), { orderId: id, captureId: order.captureId }) } };
}

const scenarioSchema = z.object({ scenario: z.enum(MISMATCH_SCENARIOS) });

// Demo control: simulates the merchant's billing for the chosen scenario and compares it with the signed mandate.
// A mismatch creates (once per order and scenario, enforced by a unique constraint) a refund draft carrying the
// evidence and a suggested partial amount: the overcharge, capped at what is still refundable.
export async function checkBilling(db: PrismaClient, sessionId: string, id: string, input: unknown): Promise<Result> {
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: `scenario must be one of ${MISMATCH_SCENARIOS.join(', ')}.` } };
  const { scenario } = parsed.data;
  const order = await loadOrder(db, sessionId, id);
  if (!order) return notFound;
  if (order.status !== 'PAID' || !order.captureId || !order.mandate) return { status: 409, body: { error: 'Only a paid order with a signed mandate can be checked.', status: order.status } };
  const payload = JSON.parse(order.mandate.payload) as MandatePayload;
  const billing = simulateBilling(payload.cart, scenario);
  const diff = diffBilling(payload.cart, billing);
  if (!diff.length) {
    await audit(db, sessionId, 'billingCheck', 'MATCH', { orderId: id, scenario });
    return { status: 200, body: { scenario, billing, diff, refundRequest: null } };
  }

  const evidence: RefundEvidence = { mandate: { payload: order.mandate.payload, signature: order.mandate.signature, publicKeyFingerprint: order.mandate.publicKeyFingerprint }, billing, diff };
  const suggestedCents = Math.min(overchargeCents(payload.cart, billing), refundableCents(order, order.refundRequests));
  const created = await db.$transaction(async tx => {
    const inserted = await tx.refundRequest.createMany({
      data: [{ sessionId, orderId: id, scenario, idempotencyKey: `refund:${id}:${scenario}`, evidenceJson: JSON.stringify(evidence), suggestedCents, capturedCents: order.totalCents }],
      skipDuplicates: true,
    });
    if (inserted.count) {
      await audit(tx, sessionId, 'billingCheck', 'MISMATCH', { orderId: id, scenario, diff });
      await audit(tx, sessionId, 'refundDraft', 'CREATED', { orderId: id, scenario, suggestedCents, capturedCents: order.totalCents, diff });
    }
    return inserted.count > 0;
  });
  const draft = await db.refundRequest.findUniqueOrThrow({ where: { orderId_scenario: { orderId: id, scenario } } });
  return { status: created ? 201 : 200, body: { scenario, billing, diff, refundRequest: refundView(draft), created } };
}

const refundInputSchema = z.object({ mode: z.enum(['PARTIAL', 'FULL']), amountCents: z.number().int().optional() });

// User clicked Refund on a draft. PARTIAL refunds amountCents; FULL refunds everything still refundable (PayPal gets
// no amount). Validated against the captured amount minus refunds already committed for the order, read under a
// per-order advisory lock so two refunds on one order cannot together exceed the capture. A draft is claimed
// DRAFT -> REFUNDING exactly once, so the same mismatch is never refunded twice; the provider request carries the
// draft's idempotency key. A refund whose outcome is unknown, or left REFUNDING past the lease (a crash before the
// outcome was written), stays counted and can be retried with the same mode, amount and key (see refundRetryable).
// A recent REFUNDING row without an outcome is most likely still in flight and is left alone (409).
export async function executeRefund(db: PrismaClient, provider: PaymentProvider, sessionId: string, refundId: string, input: unknown, now = new Date()): Promise<Result> {
  const parsed = refundInputSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: 'mode must be PARTIAL or FULL; amountCents must be a whole number of cents.' } };
  const draft = await db.refundRequest.findFirst({ where: ownedBy(sessionId, refundId), include: { order: true } });
  if (!draft) return { status: 404, body: { error: 'Refund request not found.' } };
  const { order } = draft;
  const retrying = refundRetryable(draft, now);
  if (draft.status !== 'DRAFT' && !retrying) return { status: 409, body: { error: draft.status === 'REFUNDING' ? 'This refund is being processed.' : 'This refund was already submitted.', status: draft.status } };
  if (order.status !== 'PAID' || !order.captureId) return { status: 409, body: { error: 'Only a paid order can be refunded.', status: order.status } };
  if (order.provider !== provider.kind) return { status: 409, body: { error: 'The payment provider changed since this order was paid.' } };
  const captureId = order.captureId;

  type Claim = { kind: 'claimed'; mode: 'PARTIAL' | 'FULL'; amountCents: number } | { kind: 'invalid'; error: string } | { kind: 'conflict' };
  const claim = await db.$transaction(async (tx: Prisma.TransactionClient): Promise<Claim> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`refund:${order.id}`}))`;
    if (retrying) {
      // Re-claimed conditionally on the row as read (its updatedAt), so of several concurrent retries only one goes on;
      // the claim renews the lease.
      const moved = await tx.refundRequest.updateMany({
        where: { ...ownedBy(sessionId, refundId), status: 'REFUNDING', updatedAt: draft.updatedAt },
        data: { failureReason: null, updatedAt: new Date(Math.max(Date.now(), draft.updatedAt.getTime() + 1)) },
      });
      if (!moved.count || draft.amountCents === null) return { kind: 'conflict' };
      await audit(tx, sessionId, 'refund', 'RETRIED', { orderId: order.id, refundRequestId: refundId, mode: draft.mode, amountCents: draft.amountCents, previous: draft.failureReason ?? 'STALE' });
      return { kind: 'claimed', mode: draft.mode === 'FULL' ? 'FULL' : 'PARTIAL', amountCents: draft.amountCents };
    }
    const others = await tx.refundRequest.findMany({ where: { orderId: order.id, id: { not: refundId } }, select: { status: true, amountCents: true } });
    const remaining = refundableCents(order, others);
    const { mode } = parsed.data;
    const amountCents = mode === 'FULL' ? remaining : parsed.data.amountCents;
    if (amountCents === undefined) return { kind: 'invalid', error: 'Enter the amount to refund.' };
    if (amountCents <= 0) return { kind: 'invalid', error: remaining > 0 ? 'The refund amount must be more than $0.00.' : 'Nothing is left to refund on this payment.' };
    if (amountCents > remaining) return { kind: 'invalid', error: `The refund amount is more than the ${(remaining / 100).toFixed(2)} USD still refundable.` };
    const moved = await tx.refundRequest.updateMany({ where: { ...ownedBy(sessionId, refundId), status: 'DRAFT' }, data: { status: 'REFUNDING', mode, amountCents } });
    if (!moved.count) return { kind: 'conflict' };
    await audit(tx, sessionId, 'refund', 'SUBMITTED', { orderId: order.id, refundRequestId: refundId, scenario: draft.scenario, mode, amountCents, remainingCents: remaining });
    return { kind: 'claimed', mode, amountCents };
  });
  if (claim.kind === 'invalid') return { status: 400, body: { error: claim.error } };
  if (claim.kind === 'conflict') return { status: 409, body: { error: 'This refund was already submitted.' } };

  let result: RefundResult;
  try {
    result = interpretRefund(await provider.refundCapture(captureId, claim.mode === 'FULL' ? null : claim.amountCents, draft.idempotencyKey));
  } catch (error) {
    if (error instanceof PayPalError && error.outcomeUnknown) {
      await db.$transaction([
        db.refundRequest.updateMany({ where: { ...ownedBy(sessionId, refundId), status: 'REFUNDING' }, data: { failureReason: REFUND_UNKNOWN } }),
        audit(db, sessionId, 'refund', 'UNKNOWN', { orderId: order.id, refundRequestId: refundId, reason: error.code }),
      ]);
      return { status: 503, body: { error: 'The payment provider did not answer. Try again; the refund will not be made twice.', status: 'REFUNDING' } };
    }
    result = { ok: false, reason: error instanceof PayPalError ? error.code : 'PROVIDER_ERROR' };
  }

  const status = result.ok ? (result.status === 'COMPLETED' ? 'REFUNDED' : 'PENDING') : 'FAILED';
  const amountCents = result.ok ? result.amountCents ?? claim.amountCents : claim.amountCents;
  await db.$transaction(async tx => {
    const moved = await tx.refundRequest.updateMany({
      where: { ...ownedBy(sessionId, refundId), status: 'REFUNDING' },
      data: result.ok
        ? { status, amountCents, providerRefundId: result.refundId, providerStatus: result.status, failureReason: null }
        : { status, providerStatus: result.status ?? null, failureReason: result.reason },
    });
    if (moved.count) await audit(tx, sessionId, 'refund', status, { orderId: order.id, refundRequestId: refundId, captureId, mode: claim.mode, amountCents, ...result });
  });
  return result.ok
    ? { status: 200, body: { status, mode: claim.mode, amountCents, refundId: result.refundId, providerStatus: result.status } }
    : { status: 502, body: { status, reason: result.reason } };
}
