import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '../lib/db';
import { runtimeCatalog } from '../src/server/catalog';
import { createSession, SESSION_COOKIE } from '../src/server/session';
import { capturePayment, decideOrder, getPolicy, saveCart, schedulePrecharge, setIntent, setPolicy, submitCart, type PaymentSnapshot } from '../src/server/orders';
import { loadMandateSigner, mandateSigner } from '../src/server/mandate';
import { checkBilling, executeRefund, getOrderProtection, REFUND_LEASE_MS, verifyOrderMandate } from '../src/server/protection';
import { createMockProvider, type PaymentProvider } from '../src/server/payments/provider';
import { RECONSTRUCTED_POLICY_NOTE, type MandatePayload } from '../src/domain/mandate';
import { buildEvidence, evidencePdfLines } from '../src/server/evidence';
import type { CartLine } from '../src/domain/policy';
import { GET as orderRoute } from '../app/api/orders/[id]/route';
import { GET as verifyRoute } from '../app/api/orders/[id]/mandate/verify/route';
import { POST as mismatchRoute } from '../app/api/orders/[id]/mismatch/route';
import { GET as evidenceRoute } from '../app/api/orders/[id]/evidence/route';
import { POST as refundRoute } from '../app/api/refunds/[id]/route';
import { GET as publicKeyRoute } from '../app/api/mandate/public-key/route';

// Requires the throwaway DB prepared by scripts/test.ts (npm test), which also blanks PayPal credentials and
// MANDATE_SIGNING_KEY (so mandates use the development key).
before(async () => {
  for (const product of runtimeCatalog()) await db.product.upsert({ where: { id: product.id }, create: product, update: product });
});
after(() => db.$disconnect());

const cookie = (id: string) => `${SESSION_COOKIE}=${id}`;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const lanterns: CartLine[] = [{ productId: 'camp-06', quantity: 2 }];
const LANTERNS_CENTS = 3798;

// Wraps a provider and records every refund request.
function spy(inner: PaymentProvider) {
  const refunds: { captureId: string; amountCents: number | null; key: string }[] = [];
  const provider: PaymentProvider = {
    kind: inner.kind,
    merchantId: inner.merchantId,
    createOrder: (order, urls) => inner.createOrder(order, urls),
    getOrder: id => inner.getOrder(id),
    captureOrder: id => inner.captureOrder(id),
    async refundCapture(captureId, amountCents, key) { refunds.push({ captureId, amountCents, key }); return inner.refundCapture(captureId, amountCents, key); },
  };
  return { provider, refunds };
}

async function awaitingPayment(provider: PaymentProvider, cart: CartLine[] = lanterns) {
  const session = await createSession(db);
  await setIntent(db, session.id, { budgetCents: 4000, category: 'Camping', quantity: 2 });
  await saveCart(db, session.id, cart.map(l => ({ ...l, reason: 'Best-rated rechargeable lantern in budget.' })));
  const submitted = await submitCart(db, session.id);
  assert.ok(submitted.ok);
  assert.equal((await decideOrder(db, provider, session.id, submitted.orderId, 'APPROVED')).body.status, 'AWAITING_PAYMENT');
  // Backdated past the longest pre-charge delay, as in checkout.db.test.ts.
  assert.equal((await schedulePrecharge(db, session.id, submitted.orderId, new Date(Date.now() - 660_000))).status, 200);
  return { sessionId: session.id, orderId: submitted.orderId };
}

async function paidOrder(provider: PaymentProvider) {
  const order = await awaitingPayment(provider);
  assert.equal((await capturePayment(db, provider, order.sessionId, order.orderId)).body.status, 'PAID');
  return order;
}

async function draftFor(sessionId: string, orderId: string, scenario: string) {
  const checked = await checkBilling(db, sessionId, orderId, { scenario });
  assert.ok(checked.status === 201 || checked.status === 200, JSON.stringify(checked.body));
  return checked.body.refundRequest as { id: string; suggestedCents: number; status: string };
}

const audits = (sessionId: string, action: string) => db.auditLog.findMany({ where: { sessionId, action }, orderBy: { createdAt: 'asc' } });

test('capture issues a signed mandate in the same step; it verifies, and the public key matches', async () => {
  const { provider } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { mandate: true } });
  assert.ok(order.mandate);
  const payload = JSON.parse(order.mandate.payload) as MandatePayload;
  assert.equal(payload.orderId, orderId);
  assert.deepEqual(payload.intent, { budgetCents: 4000, category: 'Camping', quantity: 2 });
  assert.equal(payload.cart.totalCents, LANTERNS_CENTS);
  assert.equal(payload.payment.providerOrderId, order.providerOrderId);
  assert.equal(payload.payment.captureId, order.captureId);
  assert.equal(payload.selection[0].agentReason, 'Best-rated rechargeable lantern in budget.');
  assert.deepEqual(payload.policy.layer2.allowedCategories, ['Camping', 'Household']);
  assert.equal(order.mandate.publicKeyFingerprint, mandateSigner().fingerprint);
  assert.equal((await audits(sessionId, 'mandate')).map(a => a.outcome).join(), 'ISSUED');

  const res = await verifyRoute(new Request(`http://localhost/api/orders/${orderId}/mandate/verify`, { headers: { cookie: cookie(sessionId) } }), ctx(orderId));
  assert.equal(res.status, 200);
  const verified = await res.json() as { valid: boolean; checks: Record<string, boolean> };
  assert.equal(verified.valid, true);
  const key = await (await publicKeyRoute()).json() as { fingerprint: string; publicKeyPem: string; algorithm: string };
  assert.equal(key.fingerprint, order.mandate.publicKeyFingerprint);
  assert.equal(key.algorithm, 'Ed25519');
  // The database refuses to rewrite a mandate.
  await assert.rejects(db.mandate.update({ where: { orderId }, data: { payload: order.mandate.payload.replace('3798', '1') } }));
  assert.equal((await db.mandate.findUniqueOrThrow({ where: { orderId } })).payload, order.mandate.payload);
  // Verified under a different key, it is not valid.
  const other = loadMandateSigner({ MANDATE_SIGNING_KEY: Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64') });
  assert.equal((await verifyOrderMandate(db, sessionId, orderId, () => other)).body.valid, false);
});

test('the mandate records the cart and policy the payment was approved on, not a policy changed before capture', async () => {
  const { provider } = spy(createMockProvider());
  const { sessionId, orderId } = await awaitingPayment(provider);
  const approved = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.ok(approved.paymentSnapshotJson);
  const snapshot = JSON.parse(approved.paymentSnapshotJson) as PaymentSnapshot;
  assert.deepEqual(snapshot.policy.allowedCategories, ['Camping', 'Household']);
  assert.equal(snapshot.evaluation.totalCents, LANTERNS_CENTS);

  // Tightened after approval (applies immediately), before capture.
  const { policy } = await getPolicy(db, sessionId);
  const tightened = await setPolicy(db, sessionId, { ...policy, allowedCategories: ['Household'], requireApprovalAboveCents: 0 });
  assert.equal(tightened.body.outcome, 'APPLIED', JSON.stringify(tightened.body));
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).body.status, 'PAID');

  const payload = JSON.parse((await db.mandate.findUniqueOrThrow({ where: { orderId } })).payload) as MandatePayload;
  assert.equal(payload.policy.source, 'payment_time_snapshot');
  assert.equal(payload.policy.note, undefined);
  assert.ok(evidencePdfLines((await buildEvidence(db, sessionId, orderId))!).some(l => l.text.startsWith('Policy source: Payment-time snapshot') && l.color !== 'red'));
  assert.deepEqual(payload.policy.layer2, snapshot.policy);
  assert.deepEqual(payload.policy.layer1, snapshot.layer1);
  assert.deepEqual([payload.policy.decision, payload.policy.reasons], [snapshot.evaluation.decision, snapshot.evaluation.reasons]);
  assert.deepEqual(payload.cart.items, snapshot.evaluation.lines.map(({ productId, name, seller, category, quantity, unitCents, subtotalCents }) => ({ productId, name, seller, category, quantity, unitCents, subtotalCents })));
  assert.equal((await verifyOrderMandate(db, sessionId, orderId)).body.valid, true);
});

test('an order awaiting payment with no decision snapshot is refused before any provider call', async () => {
  const mock = createMockProvider();
  let calls = 0;
  const provider: PaymentProvider = { ...mock, getOrder: id => { calls++; return mock.getOrder(id); }, captureOrder: id => { calls++; return mock.captureOrder(id); } };
  const { sessionId, orderId } = await awaitingPayment(provider);
  await db.order.update({ where: { id: orderId }, data: { paymentSnapshotJson: null } });
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).status, 409);
  assert.equal(calls, 0);
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { mandate: true } });
  assert.deepEqual([order.status, order.mandate], ['AWAITING_PAYMENT', null]);
});

test('a legacy CAPTURING order with no decision snapshot is still recorded, its mandate marked as reconstructed at recovery', async () => {
  const { provider } = spy(createMockProvider());
  const { sessionId, orderId } = await awaitingPayment(provider);
  // Approved before snapshots existed, then a crash left it CAPTURING (money may have moved).
  await db.order.update({ where: { id: orderId }, data: { paymentSnapshotJson: null, status: 'CAPTURING', updatedAt: new Date(Date.now() - 120_000) } });
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).body.status, 'PAID');

  const payload = JSON.parse((await db.mandate.findUniqueOrThrow({ where: { orderId } })).payload) as MandatePayload;
  assert.equal(payload.policy.source, 'reconstructed_at_recovery');
  assert.equal(payload.policy.note, RECONSTRUCTED_POLICY_NOTE);
  assert.equal((await verifyOrderMandate(db, sessionId, orderId)).body.valid, true);
  // The order view hands the marker to the UI, and the evidence PDF flags it in red.
  const view = await getOrderProtection(db, sessionId, orderId);
  assert.equal((view.body.mandate as { payload: MandatePayload }).payload.policy.source, 'reconstructed_at_recovery');
  const line = evidencePdfLines((await buildEvidence(db, sessionId, orderId))!).find(l => l.text.startsWith('Policy source:'));
  assert.ok(line);
  assert.match(line.text, /Reconstructed at recovery\. Not the payment-time policy/);
  assert.equal(line.color, 'red');
});

test('capture fails closed without a signing key in production: no provider capture, order untouched', async () => {
  const mock = createMockProvider();
  let captures = 0;
  const provider: PaymentProvider = { ...spy(mock).provider, captureOrder: id => { captures++; return mock.captureOrder(id); } };
  const { sessionId, orderId } = await awaitingPayment(provider);
  await assert.rejects(capturePayment(db, provider, sessionId, orderId, undefined, () => loadMandateSigner({ NODE_ENV: 'production' })), /MANDATE_SIGNING_KEY/);
  assert.equal(captures, 0);
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { mandate: true } });
  assert.deepEqual([order.status, order.mandate], ['AWAITING_PAYMENT', null]);
  // With a key the same order captures normally.
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).body.status, 'PAID');
  assert.equal(captures, 1);
});

test('billing check: no mismatch makes no draft; a mismatch makes one draft with evidence, once per scenario', async () => {
  const { provider } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  const none = await checkBilling(db, sessionId, orderId, { scenario: 'none' });
  assert.deepEqual([none.status, none.body.diff, none.body.refundRequest], [200, [], null]);
  assert.equal((await checkBilling(db, sessionId, orderId, { scenario: 'bogus' })).status, 400);

  const res = await mismatchRoute(new Request(`http://localhost/api/orders/${orderId}/mismatch`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie(sessionId) }, body: JSON.stringify({ scenario: 'extra_quantity' }),
  }), ctx(orderId));
  assert.equal(res.status, 201);
  const body = await res.json() as { diff: { field: string; expected: number; actual: number }[]; refundRequest: { id: string; suggestedCents: number; status: string } };
  assert.deepEqual(body.diff.find(d => d.field === 'items[camp-06].quantity'), { field: 'items[camp-06].quantity', expected: 2, actual: 3 });
  assert.equal(body.refundRequest.suggestedCents, 1899);
  assert.equal(body.refundRequest.status, 'DRAFT');
  const stored = await db.refundRequest.findUniqueOrThrow({ where: { id: body.refundRequest.id } });
  const evidence = JSON.parse(stored.evidenceJson) as { mandate: { payload: string; signature: string }; diff: unknown[] };
  const mandate = await db.mandate.findUniqueOrThrow({ where: { orderId } });
  assert.deepEqual([evidence.mandate.payload, evidence.mandate.signature], [mandate.payload, mandate.signature]);
  assert.deepEqual(evidence.diff, body.diff);
  assert.equal(stored.idempotencyKey, `refund:${orderId}:extra_quantity`);

  // The same mismatch again returns the same draft; the unique constraint refuses a second row outright.
  const again = await checkBilling(db, sessionId, orderId, { scenario: 'extra_quantity' });
  assert.deepEqual([again.status, (again.body.refundRequest as { id: string }).id, again.body.created], [200, body.refundRequest.id, false]);
  await assert.rejects(db.refundRequest.create({ data: { sessionId, orderId, scenario: 'extra_quantity', idempotencyKey: 'other', evidenceJson: '{}', suggestedCents: 1, capturedCents: 1 } }), (e: unknown) => (e as { code?: string }).code === 'P2002');
  assert.equal(await db.refundRequest.count({ where: { orderId } }), 1);
  assert.deepEqual((await audits(sessionId, 'refundDraft')).map(a => a.outcome), ['CREATED']);
  assert.deepEqual((await audits(sessionId, 'billingCheck')).map(a => a.outcome), ['MATCH', 'MISMATCH']);
});

test('partial refund: the overcharge is refunded through the provider with the draft key, and audited', async () => {
  const { provider, refunds } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  assert.equal((await draftFor(sessionId, orderId, 'hidden_fee')).suggestedCents, 799);
  const fresh = await draftFor(sessionId, orderId, 'price_change');
  const result = await executeRefund(db, provider, sessionId, fresh.id, { mode: 'PARTIAL', amountCents: fresh.suggestedCents });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([result.body.status, result.body.mode, result.body.amountCents], ['REFUNDED', 'PARTIAL', 380]);
  assert.match(String(result.body.refundId), /^MOCK-/);
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.deepEqual(refunds, [{ captureId: order.captureId, amountCents: 380, key: `refund:${orderId}:price_change` }]);
  const row = await db.refundRequest.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.deepEqual([row.status, row.mode, row.amountCents, row.providerRefundId], ['REFUNDED', 'PARTIAL', 380, result.body.refundId]);
  const outcomes = (await audits(sessionId, 'refund')).filter(a => JSON.parse(a.detail).refundRequestId === fresh.id).map(a => a.outcome);
  assert.deepEqual(outcomes, ['SUBMITTED', 'REFUNDED']);
});

test('full refund: refunds what is left on the capture, with no amount sent to the provider', async () => {
  const { provider, refunds } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  const partial = await draftFor(sessionId, orderId, 'hidden_fee');
  assert.equal((await executeRefund(db, provider, sessionId, partial.id, { mode: 'PARTIAL', amountCents: 799 })).status, 200);
  const full = await draftFor(sessionId, orderId, 'extra_quantity');
  const result = await executeRefund(db, provider, sessionId, full.id, { mode: 'FULL' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([result.body.status, result.body.mode, result.body.amountCents], ['REFUNDED', 'FULL', LANTERNS_CENTS - 799]);
  assert.equal(refunds[1].amountCents, null);
  const view = await (await orderRoute(new Request(`http://localhost/api/orders/${orderId}`, { headers: { cookie: cookie(sessionId) } }), ctx(orderId))).json() as { refundedCents: number; refundableCents: number };
  assert.deepEqual([view.refundedCents, view.refundableCents], [LANTERNS_CENTS, 0]);
});

test('duplicate refund for the same mismatch is blocked, also under concurrency', async () => {
  const { provider, refunds } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  const draft = await draftFor(sessionId, orderId, 'extra_quantity');
  const results = await Promise.all([1, 2, 3].map(() => executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL', amountCents: 1899 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
  assert.equal(refunds.length, 1);
  const later = await executeRefund(db, provider, sessionId, draft.id, { mode: 'FULL' });
  assert.equal(later.status, 409);
  assert.equal(refunds.length, 1);
  // Re-running the same mismatch does not open a second, refundable draft.
  const again = await checkBilling(db, sessionId, orderId, { scenario: 'extra_quantity' });
  assert.equal((again.body.refundRequest as { status: string }).status, 'REFUNDED');
  assert.equal((await executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL', amountCents: 1 })).status, 409);
  assert.equal(refunds.length, 1);
});

test('a refund left REFUNDING by a crash after the provider accepted it is retryable once stale, with the same key and amount', async () => {
  const { provider, refunds } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  const draft = await draftFor(sessionId, orderId, 'extra_quantity');
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const key = `refund:${orderId}:extra_quantity`;
  // The crash: the claim was written and PayPal refunded, but the process died before recording the outcome.
  await db.refundRequest.update({ where: { id: draft.id }, data: { status: 'REFUNDING', mode: 'PARTIAL', amountCents: 1899 } });
  const accepted = await provider.refundCapture(order.captureId!, 1899, key) as { id: string };
  const claimedAt = (await db.refundRequest.findUniqueOrThrow({ where: { id: draft.id } })).updatedAt;

  // Within the lease it may still be in flight: no retry offered, a retry is refused, no provider call.
  const view = async (now: Date) => ((await getOrderProtection(db, sessionId, orderId, now)).body.refundRequests as { id: string; retryable: boolean }[]).find(r => r.id === draft.id)!;
  const soon = new Date(claimedAt.getTime() + 1_000);
  assert.equal((await view(soon)).retryable, false);
  assert.equal((await executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL', amountCents: 1899 }, soon)).status, 409);
  assert.equal(refunds.length, 1);
  // Another session never sees or retries it.
  assert.equal((await executeRefund(db, provider, (await createSession(db)).id, draft.id, { mode: 'PARTIAL', amountCents: 1899 }, new Date(claimedAt.getTime() + REFUND_LEASE_MS))).status, 404);

  // Past the lease the owner sees the retry; concurrent retries make one provider call, and the stored amount and
  // key are reused whatever amount the client sends.
  const stale = new Date(claimedAt.getTime() + REFUND_LEASE_MS);
  assert.equal((await view(stale)).retryable, true);
  const results = await Promise.all([1, 2].map(() => executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL', amountCents: 5 }, stale)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const ok = results.find(r => r.status === 200)!;
  assert.deepEqual([ok.body.status, ok.body.amountCents, ok.body.refundId], ['REFUNDED', 1899, accepted.id]);
  assert.deepEqual(refunds.slice(1), [{ captureId: order.captureId, amountCents: 1899, key }]);
  const row = await db.refundRequest.findUniqueOrThrow({ where: { id: draft.id } });
  assert.deepEqual([row.status, row.amountCents, row.providerRefundId, row.failureReason], ['REFUNDED', 1899, accepted.id, null]);
  assert.equal((await view(new Date(Date.now() + REFUND_LEASE_MS))).retryable, false);
  const outcomes = (await audits(sessionId, 'refund')).filter(a => JSON.parse(a.detail).refundRequestId === draft.id).map(a => a.outcome);
  assert.deepEqual(outcomes, ['RETRIED', 'REFUNDED']);
});

test('over-refund is blocked: more than captured, zero, or more than what is left after earlier refunds', async () => {
  const { provider, refunds } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  const draft = await draftFor(sessionId, orderId, 'price_change');
  for (const amountCents of [LANTERNS_CENTS + 1, 0, -5]) {
    const refused = await executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL', amountCents });
    assert.equal(refused.status, 400, `amount ${amountCents}`);
  }
  assert.equal((await executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL' })).status, 400);
  assert.equal((await executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL', amountCents: 1.5 })).status, 400);
  assert.equal((await db.refundRequest.findUniqueOrThrow({ where: { id: draft.id } })).status, 'DRAFT');
  assert.equal(refunds.length, 0);

  // Refund everything but $1.00 on one mismatch; another mismatch can then refund at most $1.00.
  assert.equal((await executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL', amountCents: LANTERNS_CENTS - 100 })).status, 200);
  const second = await draftFor(sessionId, orderId, 'hidden_fee');
  assert.equal(second.suggestedCents, 100);
  assert.equal((await executeRefund(db, provider, sessionId, second.id, { mode: 'PARTIAL', amountCents: 101 })).status, 400);
  assert.equal(refunds.length, 1);
  assert.equal((await executeRefund(db, provider, sessionId, second.id, { mode: 'PARTIAL', amountCents: 100 })).status, 200);
  const third = await draftFor(sessionId, orderId, 'extra_quantity');
  assert.equal(third.suggestedCents, 0);
  assert.equal((await executeRefund(db, provider, sessionId, third.id, { mode: 'FULL' })).status, 400);
  assert.equal(refunds.length, 2);
});

test('another session\'s order and refund are 404 on every protection route', async () => {
  const { provider, refunds } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  const draft = await draftFor(sessionId, orderId, 'hidden_fee');
  const other = await createSession(db);
  const as = (sid: string) => ({ cookie: cookie(sid) });
  const json = { 'content-type': 'application/json' };

  assert.equal((await orderRoute(new Request(`http://localhost/api/orders/${orderId}`, { headers: as(other.id) }), ctx(orderId))).status, 404);
  assert.equal((await verifyRoute(new Request(`http://localhost/api/orders/${orderId}/mandate/verify`, { headers: as(other.id) }), ctx(orderId))).status, 404);
  assert.equal((await evidenceRoute(new Request(`http://localhost/api/orders/${orderId}/evidence?format=pdf`, { headers: as(other.id) }), ctx(orderId))).status, 404);
  assert.equal((await mismatchRoute(new Request(`http://localhost/api/orders/${orderId}/mismatch`, { method: 'POST', headers: { ...json, ...as(other.id) }, body: JSON.stringify({ scenario: 'price_change' }) }), ctx(orderId))).status, 404);
  assert.equal((await refundRoute(new Request(`http://localhost/api/refunds/${draft.id}`, { method: 'POST', headers: { ...json, ...as(other.id) }, body: JSON.stringify({ mode: 'FULL' }) }), ctx(draft.id))).status, 404);
  assert.equal((await executeRefund(db, provider, other.id, draft.id, { mode: 'FULL' })).status, 404);
  assert.equal((await checkBilling(db, other.id, orderId, { scenario: 'price_change' })).status, 404);
  // No session, or a cross-site origin, never reaches the order.
  assert.equal((await orderRoute(new Request(`http://localhost/api/orders/${orderId}`), ctx(orderId))).status, 401);
  assert.equal((await refundRoute(new Request(`http://localhost/api/refunds/${draft.id}`, { method: 'POST', headers: { ...json, ...as(sessionId), origin: 'https://evil.example' }, body: JSON.stringify({ mode: 'FULL' }) }), ctx(draft.id))).status, 403);
  assert.equal(refunds.length, 0);
  assert.equal((await db.refundRequest.findUniqueOrThrow({ where: { id: draft.id } })).status, 'DRAFT');
  assert.equal(await db.refundRequest.count({ where: { orderId } }), 1);
});

test('evidence package: JSON with mandate, verification, diff and audit trail; PDF download', async () => {
  const { provider } = spy(createMockProvider());
  const { sessionId, orderId } = await paidOrder(provider);
  const draft = await draftFor(sessionId, orderId, 'extra_quantity');
  assert.equal((await executeRefund(db, provider, sessionId, draft.id, { mode: 'PARTIAL', amountCents: 1899 })).status, 200);

  const res = await evidenceRoute(new Request(`http://localhost/api/orders/${orderId}/evidence?format=json`, { headers: { cookie: cookie(sessionId) } }), ctx(orderId));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="trustcart-evidence-.+\.json"/);
  const pkg = await res.json() as {
    order: { id: string; captureId: string; providerOrderId: string }; verification: { valid: boolean };
    mandate: { canonicalPayload: string; signature: string; publicKeyPem: string; algorithm: string };
    mismatches: { diff: unknown[]; status: string }[]; auditTrail: { action: string; outcome: string }[];
  };
  assert.equal(pkg.order.id, orderId);
  assert.ok(pkg.order.captureId && pkg.order.providerOrderId);
  assert.equal(pkg.verification.valid, true);
  assert.equal(pkg.mandate.algorithm, 'Ed25519');
  assert.match(pkg.mandate.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.equal(pkg.mismatches[0].status, 'REFUNDED');
  assert.ok(pkg.mismatches[0].diff.length > 0);
  const trail = pkg.auditTrail.map(a => `${a.action}:${a.outcome}`);
  for (const step of ['checkout:READY', 'capture:PAID', 'mandate:ISSUED', 'refundDraft:CREATED', 'refund:SUBMITTED', 'refund:REFUNDED']) assert.ok(trail.includes(step), step);

  const pdf = await evidenceRoute(new Request(`http://localhost/api/orders/${orderId}/evidence?format=pdf`, { headers: { cookie: cookie(sessionId) } }), ctx(orderId));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
  assert.ok(bytes.startsWith('%PDF-1.4'));
  assert.ok(bytes.includes(orderId));
  assert.ok(bytes.includes('VALID: the mandate signature verifies'));
});
