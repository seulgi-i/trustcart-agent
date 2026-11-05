import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../lib/db';
import { runtimeCatalog } from '../src/server/catalog';
import { createSession, SESSION_COOKIE } from '../src/server/session';
import { cancelPayment, capturePayment, decideOrder, getPolicy, saveCart, schedulePrecharge, setIntent, setPolicy, submitCart } from '../src/server/orders';
import { assertSandboxHost, PayPalError, type CheckoutOrder } from '../src/server/payments/paypal';
import { checkoutUrls, createMockProvider, type PaymentProvider } from '../src/server/payments/provider';
import { selectProvider } from '../src/server/payments/select';
import type { CartLine, Reason } from '../src/domain/policy';
import { defaultSpendingPolicy, localClock } from '../src/domain/spending-policy';
import { PATCH as reviewOrder } from '../app/api/approvals/[id]/route';
import { POST as captureRoute } from '../app/api/checkout/[id]/capture/route';
import { POST as cancelRoute } from '../app/api/checkout/[id]/cancel/route';
import { POST as prechargeRoute } from '../app/api/checkout/[id]/precharge/route';
import { POST as prechargeCancelRoute } from '../app/api/checkout/[id]/precharge/cancel/route';
import { GET as getPolicyRoute, PUT as putPolicyRoute } from '../app/api/policy/route';

// Requires the throwaway DB prepared by scripts/test.ts (npm test), which also blanks PayPal credentials.
before(async () => {
  for (const product of runtimeCatalog()) await db.product.upsert({ where: { id: product.id }, create: product, update: product });
});
after(() => db.$disconnect());

const cookie = (id: string) => `${SESSION_COOKIE}=${id}`;
const post = (route: typeof captureRoute, action: string, id: string, headers: Record<string, string>) =>
  route(new Request(`http://localhost/api/checkout/${id}/${action}`, { method: 'POST', headers }), { params: Promise.resolve({ id }) });

async function sessionWithOrder(cart: CartLine[], intent = { budgetCents: 4000, category: 'Camping', quantity: 2 }) {
  const session = await createSession(db);
  await setIntent(db, session.id, intent);
  await saveCart(db, session.id, cart);
  const submitted = await submitCart(db, session.id);
  assert.ok(submitted.ok);
  return { sessionId: session.id, orderId: submitted.orderId, status: submitted.status };
}

// Wraps a provider, counting calls and recording what was sent. getOrder can be rewritten to simulate a tampered order.
function spy(inner: PaymentProvider, opts: { rewriteGet?: (order: Record<string, unknown>) => unknown; failCapture?: Error } = {}) {
  const calls = { create: 0, get: 0, capture: 0 };
  const created: CheckoutOrder[] = [];
  const provider: PaymentProvider = {
    kind: inner.kind,
    merchantId: inner.merchantId,
    async createOrder(order, urls) { calls.create++; created.push(order); return inner.createOrder(order, urls); },
    async getOrder(id) {
      calls.get++;
      const order = await inner.getOrder(id) as Record<string, unknown>;
      return opts.rewriteGet ? opts.rewriteGet(order) : order;
    },
    async captureOrder(id) {
      calls.capture++;
      const result = await inner.captureOrder(id);
      if (opts.failCapture) throw opts.failCapture;
      return result;
    },
  };
  return { provider, calls, created };
}

// The pre-charge notice is backdated past the longest allowed delay (600 s), so these tests exercise capture itself.
// The pre-charge gate has its own tests below.
const prechargeShown = (sessionId: string, orderId: string) => schedulePrecharge(db, sessionId, orderId, new Date(Date.now() - 660_000));
async function awaitingPayment(provider: PaymentProvider, cart: CartLine[] = [{ productId: 'camp-06', quantity: 2 }]) {
  const order = await sessionWithOrder(cart);
  const decided = await decideOrder(db, provider, order.sessionId, order.orderId, 'APPROVED');
  assert.equal(decided.body.status, 'AWAITING_PAYMENT');
  assert.equal((await prechargeShown(order.sessionId, order.orderId)).status, 200);
  return order;
}
const row = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const audits = (sessionId: string, action: string) => db.auditLog.findMany({ where: { sessionId, action } });

test('provider selection: mock without credentials, sandbox-only PayPal with them', () => {
  const creds = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_SANDBOX_MERCHANT_ID: 'MERCHANT1' };
  assert.equal(selectProvider({}).kind, 'mock');
  assert.equal(selectProvider({ PAYPAL_CLIENT_ID: ' ', PAYPAL_CLIENT_SECRET: '' }).kind, 'mock');
  assert.equal(selectProvider(creds).kind, 'paypal-sandbox');
  // Only one credential set: a config error, not a silent mock.
  assert.throws(() => selectProvider({ PAYPAL_CLIENT_ID: 'id' }), /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  assert.throws(() => selectProvider({ PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_SANDBOX_MERCHANT_ID: 'MERCHANT1' }), /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  // Credentials present but PayPal misconfigured: fail closed, never fall back to the mock or go live.
  assert.throws(() => selectProvider({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }));
  assert.throws(() => selectProvider({ ...creds, PAYPAL_API_BASE: 'https://api-m.paypal.com' }));
  assert.throws(() => selectProvider({ ...creds, PAYPAL_ENV: 'live' }));
  assert.throws(() => assertSandboxHost('https://api-m.paypal.com/v2/checkout/orders'));
  assert.throws(() => assertSandboxHost('http://api-m.sandbox.paypal.com/v2/checkout/orders'));
  assert.doesNotThrow(() => assertSandboxHost('https://api-m.sandbox.paypal.com/v2/checkout/orders'));
});

test('approve creates the provider order with the server catalog price and localhost checkout URLs', async () => {
  const { provider, calls, created } = spy(createMockProvider());
  const { orderId } = await awaitingPayment(provider, [{ productId: 'camp-06', quantity: 2 }]);
  const price = runtimeCatalog().find(p => p.id === 'camp-06')!.priceCents;
  assert.equal(calls.create, 1);
  assert.equal(calls.capture, 0);
  assert.equal(created[0].totalCents, price * 2);
  assert.equal(created[0].currency, 'USD');
  assert.equal(created[0].referenceId, orderId);
  assert.deepEqual(checkoutUrls(orderId), {
    returnUrl: `http://localhost:3000/checkout/return?orderId=${orderId}`,
    cancelUrl: `http://localhost:3000/checkout/cancel?orderId=${orderId}`,
  });
  assert.equal((await row(orderId)).status, 'AWAITING_PAYMENT');
});

test('capture route: PAID with captureId and audit in one step, idempotent, session-owned', async () => {
  const order = await sessionWithOrder([{ productId: 'camp-06', quantity: 2 }]);
  const approve = await reviewOrder(new Request(`http://localhost/api/approvals/${order.orderId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookie(order.sessionId) }, body: JSON.stringify({ status: 'APPROVED' }),
  }), { params: Promise.resolve({ id: order.orderId }) });
  assert.equal(approve.status, 200);
  assert.equal((await prechargeShown(order.sessionId, order.orderId)).status, 200);

  const other = await createSession(db);
  assert.equal((await post(captureRoute, 'capture', order.orderId, {})).status, 401);
  assert.equal((await post(captureRoute, 'capture', order.orderId, { cookie: cookie(other.id) })).status, 404);
  assert.equal((await post(cancelRoute, 'cancel', order.orderId, { cookie: cookie(other.id) })).status, 404);
  assert.equal((await post(captureRoute, 'capture', order.orderId, { cookie: cookie(order.sessionId), origin: 'https://evil.example' })).status, 403);
  assert.equal((await row(order.orderId)).status, 'AWAITING_PAYMENT');

  const first = await post(captureRoute, 'capture', order.orderId, { cookie: cookie(order.sessionId) });
  assert.equal(first.status, 200);
  const body = await first.json() as { status: string; captureId: string };
  assert.equal(body.status, 'PAID');
  assert.match(body.captureId, /^MOCK-/);
  const paid = await row(order.orderId);
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.captureId, body.captureId);

  const again = await post(captureRoute, 'capture', order.orderId, { cookie: cookie(order.sessionId) });
  assert.deepEqual(await again.json(), { status: 'PAID', provider: 'mock', captureId: body.captureId });
  assert.equal((await audits(order.sessionId, 'capture')).filter(a => a.outcome === 'PAID').length, 1);
  // A paid order cannot be cancelled.
  assert.equal((await post(cancelRoute, 'cancel', order.orderId, { cookie: cookie(order.sessionId) })).status, 409);
});

test('concurrent captures call the provider capture once', async () => {
  const { provider, calls } = spy(createMockProvider());
  const { sessionId, orderId } = await awaitingPayment(provider);
  const results = await Promise.all([1, 2, 3].map(() => capturePayment(db, provider, sessionId, orderId)));
  assert.equal(calls.capture, 1);
  assert.ok(results.some(r => r.status === 200 && r.body.status === 'PAID'));
  assert.equal((await row(orderId)).status, 'PAID');
});

test('capture refuses an order that is not APPROVED or does not match amount, currency or payee', async () => {
  const cases: [string, Parameters<typeof spy>[1] & { approve?: boolean }][] = [
    ['ORDER_NOT_APPROVED', { approve: false }],
    ['AMOUNT_MISMATCH', { rewriteGet: o => withUnit(o, { amount: { currency_code: 'USD', value: '0.01' } }) }],
    ['CURRENCY_MISMATCH', { rewriteGet: o => withUnit(o, { amount: { currency_code: 'EUR', value: '1.00' } }) }],
    ['PAYEE_MISMATCH', { rewriteGet: o => withUnit(o, { payee: { merchant_id: 'ATTACKER' } }) }],
    ['ORDER_ID_MISMATCH', { rewriteGet: o => ({ ...o, id: 'MOCK-other' }) }],
  ];
  for (const [reason, { approve, ...opts }] of cases) {
    const { provider, calls } = spy(createMockProvider({ approve }), opts);
    const { sessionId, orderId } = await awaitingPayment(provider);
    const result = await capturePayment(db, provider, sessionId, orderId);
    assert.deepEqual(result.body, { status: 'FAILED', provider: 'mock', reason }, reason);
    assert.equal(calls.capture, 0, reason);
    const failed = await row(orderId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.failureReason, reason);
    assert.equal(failed.captureId, null);
  }
});

function withUnit(order: Record<string, unknown>, patch: Record<string, unknown>) {
  const [unit] = order.purchase_units as Record<string, unknown>[];
  return { ...order, purchase_units: [{ ...unit, ...patch }] };
}

test('a capture that is not COMPLETED is FAILED, not PAID', async () => {
  const { provider } = spy(createMockProvider({ captureStatus: 'PENDING' }));
  const { sessionId, orderId } = await awaitingPayment(provider);
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).body.status, 'FAILED');
  assert.equal((await row(orderId)).failureReason, 'CAPTURE_NOT_COMPLETED');
});

test('unknown capture outcome: retryable, not cancellable, never captured twice', async () => {
  const mock = createMockProvider();
  const lost = spy(mock, { failCapture: new PayPalError(0, 'NETWORK_ERROR', true) });
  const { sessionId, orderId } = await awaitingPayment(lost.provider);
  assert.equal((await capturePayment(db, lost.provider, sessionId, orderId)).status, 503);
  assert.equal((await row(orderId)).status, 'AWAITING_PAYMENT');
  assert.equal((await cancelPayment(db, sessionId, orderId)).status, 409);

  // The capture did go through at the provider; the retry finds it COMPLETED and records it without a second capture.
  const retry = spy(mock);
  const result = await capturePayment(db, retry.provider, sessionId, orderId);
  assert.equal(result.body.status, 'PAID');
  assert.equal(retry.calls.capture, 0);
  assert.equal((await row(orderId)).failureReason, null);
});

test('an order stuck in CAPTURING after a crash is recovered on retry, never captured twice', async () => {
  // Simulates a crash between the provider call and our write: the row stays CAPTURING, last touched a while ago.
  const stuck = async (orderId: string, ageMs = 60_000) =>
    db.order.update({ where: { id: orderId }, data: { status: 'CAPTURING', updatedAt: new Date(Date.now() - ageMs) } });

  // PayPal already captured it: the retry records PAID from the GET without a second capture.
  const mock = createMockProvider();
  const done = spy(mock);
  const a = await awaitingPayment(done.provider);
  const providerOrderId = (await row(a.orderId)).providerOrderId!;
  const captureId = ((await mock.captureOrder(providerOrderId)) as { purchase_units: { payments: { captures: { id: string }[] } }[] }).purchase_units[0].payments.captures[0].id;
  await stuck(a.orderId);
  const recovered = await capturePayment(db, done.provider, a.sessionId, a.orderId);
  assert.deepEqual(recovered.body, { status: 'PAID', provider: 'mock', captureId });
  assert.equal(done.calls.capture, 0);
  const paid = await row(a.orderId);
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.captureId, captureId);
  const paidAudits = (await audits(a.sessionId, 'capture')).filter(x => x.outcome === 'PAID');
  assert.equal(paidAudits.length, 1);
  assert.equal(JSON.parse(paidAudits[0].detail).recovered, true);

  // Crash before the capture reached PayPal: the order is still APPROVED, so the retry captures it once.
  const approved = spy(createMockProvider());
  const b = await awaitingPayment(approved.provider);
  await stuck(b.orderId);
  const results = await Promise.all([1, 2].map(() => capturePayment(db, approved.provider, b.sessionId, b.orderId)));
  assert.ok(results.some(r => r.body.status === 'PAID'));
  assert.equal(approved.calls.capture, 1);
  assert.equal((await row(b.orderId)).status, 'PAID');

  // A fresh CAPTURING row is a capture still in flight: no provider call, no state change.
  const inFlight = spy(createMockProvider());
  const c = await awaitingPayment(inFlight.provider);
  const before = { ...inFlight.calls };
  await stuck(c.orderId, 0);
  assert.equal((await capturePayment(db, inFlight.provider, c.sessionId, c.orderId)).status, 409);
  assert.deepEqual(inFlight.calls, before);
  assert.equal((await row(c.orderId)).status, 'CAPTURING');

  // Recovery still checks the provider order: a tampered amount is FAILED, not PAID.
  const tampered = spy(createMockProvider(), { rewriteGet: o => withUnit(o, { amount: { currency_code: 'USD', value: '0.01' } }) });
  const d = await awaitingPayment(tampered.provider);
  await stuck(d.orderId);
  assert.deepEqual((await capturePayment(db, tampered.provider, d.sessionId, d.orderId)).body, { status: 'FAILED', provider: 'mock', reason: 'AMOUNT_MISMATCH' });
  assert.equal(tampered.calls.capture, 0);
});

test('cancel marks CANCELLED without any provider call, then capture is refused', async () => {
  const { provider, calls } = spy(createMockProvider());
  const { sessionId, orderId } = await awaitingPayment(provider);
  const before = { ...calls };
  const res = await post(cancelRoute, 'cancel', orderId, { cookie: cookie(sessionId) });
  assert.deepEqual(await res.json(), { status: 'CANCELLED' });
  assert.deepEqual(await (await post(cancelRoute, 'cancel', orderId, { cookie: cookie(sessionId) })).json(), { status: 'CANCELLED' });
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).status, 409);
  assert.deepEqual(calls, before);
  assert.equal((await row(orderId)).status, 'CANCELLED');
  assert.equal((await audits(sessionId, 'cancelPayment')).length, 1);
});

test('rejected and denied orders never reach create or capture', async () => {
  const { provider, calls } = spy(createMockProvider());
  const rejected = await sessionWithOrder([{ productId: 'camp-03', quantity: 10 }]);
  assert.equal(rejected.status, 'NEEDS_APPROVAL');
  assert.equal((await decideOrder(db, provider, rejected.sessionId, rejected.orderId, 'REJECTED')).status, 200);
  assert.equal((await capturePayment(db, provider, rejected.sessionId, rejected.orderId)).status, 409);
  assert.equal((await cancelPayment(db, rejected.sessionId, rejected.orderId)).status, 409);

  const denied = await sessionWithOrder([{ productId: 'home-09', quantity: 1 }]);
  assert.equal(denied.status, 'DENIED');
  assert.equal((await decideOrder(db, provider, denied.sessionId, denied.orderId, 'APPROVED')).status, 409);
  assert.equal((await capturePayment(db, provider, denied.sessionId, denied.orderId)).status, 409);
  assert.deepEqual(calls, { create: 0, get: 0, capture: 0 });
  assert.equal((await row(denied.orderId)).status, 'DENIED');
});

// Pre-charge notice. The delay is the session's effective Layer-2 prechargeDelaySeconds (default 60 s).
const lanterns: CartLine[] = [{ productId: 'camp-06', quantity: 2 }];
const defaults = defaultSpendingPolicy(['Camping', 'Household']);

test('pre-charge: default 60 s; capture is refused before scheduling and before the delay, allowed after it', async () => {
  const { provider, calls } = spy(createMockProvider());
  const order = await sessionWithOrder(lanterns);
  assert.equal((await decideOrder(db, provider, order.sessionId, order.orderId, 'APPROVED')).status, 200);
  const t0 = new Date();
  const at = (ms: number) => new Date(t0.getTime() + ms);

  // Never scheduled: refused, no provider call.
  assert.equal((await capturePayment(db, provider, order.sessionId, order.orderId, at(600_000))).status, 409);

  // Session-owned like every checkout route.
  const other = await createSession(db);
  assert.equal((await post(prechargeRoute, 'precharge', order.orderId, {})).status, 401);
  assert.equal((await post(prechargeRoute, 'precharge', order.orderId, { cookie: cookie(other.id) })).status, 404);
  assert.equal((await post(prechargeRoute, 'precharge', order.orderId, { cookie: cookie(order.sessionId), origin: 'https://evil.example' })).status, 403);

  const scheduled = await schedulePrecharge(db, order.sessionId, order.orderId, t0);
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.body.totalCents, 3798);
  assert.equal(scheduled.body.delaySeconds, 60);
  assert.equal(scheduled.body.remainingSeconds, 60);
  assert.equal(scheduled.body.merchant, 'Field Works via mock provider');
  assert.deepEqual(scheduled.body.items, ['2 × Rechargeable LED Lantern']);
  // A reload keeps the original schedule; it cannot restart or skip the countdown.
  const reloaded = await schedulePrecharge(db, order.sessionId, order.orderId, at(4_000));
  assert.equal(reloaded.body.scheduledAt, scheduled.body.scheduledAt);
  assert.equal(reloaded.body.remainingSeconds, 56);
  assert.equal((await audits(order.sessionId, 'prechargeSchedule')).length, 1);

  const early = await capturePayment(db, provider, order.sessionId, order.orderId, at(59_999));
  assert.equal(early.status, 409);
  assert.equal(early.body.retryAfterSeconds, 1);
  assert.equal((await row(order.orderId)).status, 'AWAITING_PAYMENT');
  assert.deepEqual(calls, { create: 1, get: 0, capture: 0 });

  const due = await capturePayment(db, provider, order.sessionId, order.orderId, at(60_000));
  assert.equal(due.body.status, 'PAID');
  assert.equal(calls.capture, 1);
  assert.equal((await row(order.orderId)).status, 'PAID');
});

test('pre-charge: the delay is the effective Layer-2 setting (30-600 s); longer applies now, shorter after the 24 h cool-down', async () => {
  const { provider, calls } = spy(createMockProvider());
  const { sessionId, orderId } = await sessionWithOrder(lanterns);
  for (const seconds of [29, 601]) assert.equal((await setPolicy(db, sessionId, { ...defaults, prechargeDelaySeconds: seconds })).status, 400);
  const longer = await setPolicy(db, sessionId, { ...defaults, prechargeDelaySeconds: 120 });
  assert.equal(longer.body.outcome, 'APPLIED');

  assert.equal((await decideOrder(db, provider, sessionId, orderId, 'APPROVED')).status, 200);
  const t0 = new Date();
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const scheduled = await schedulePrecharge(db, sessionId, orderId, t0);
  assert.deepEqual([scheduled.body.delaySeconds, scheduled.body.remainingSeconds], [120, 120]);
  const early = await capturePayment(db, provider, sessionId, orderId, at(60_000));
  assert.deepEqual([early.status, early.body.retryAfterSeconds], [409, 60]);

  // Mixed change: the lower review threshold applies now, the shorter delay waits, so the countdown stays 120 s.
  const mixed = await setPolicy(db, sessionId, { ...defaults, prechargeDelaySeconds: 30, requireApprovalAboveCents: 3000 }, t0);
  assert.equal(mixed.body.outcome, 'PENDING');
  assert.deepEqual([mixed.body.tightenedFields, mixed.body.loosenedFields], [['requireApprovalAboveCents'], ['prechargeDelaySeconds']]);
  assert.deepEqual((await audits(sessionId, 'setPolicy')).map(a => a.outcome).sort(), ['APPLIED', 'APPLIED', 'PENDING']);
  assert.equal((await capturePayment(db, provider, sessionId, orderId, at(30_000))).status, 409);
  assert.equal(calls.capture, 0);
  assert.equal((await capturePayment(db, provider, sessionId, orderId, at(120_000))).body.status, 'PAID');
  // After the cool-down the shorter delay is promoted on read.
  assert.equal((await getPolicy(db, sessionId, undefined, at(25 * 3_600_000))).policy.prechargeDelaySeconds, 30);
});

test('pre-charge: cancel refuses capture for good, is audited and never calls the provider', async () => {
  const { provider, calls } = spy(createMockProvider());
  const { sessionId, orderId } = await awaitingPayment(provider);
  const before = { ...calls };
  const other = await createSession(db);
  assert.equal((await post(prechargeCancelRoute, 'precharge/cancel', orderId, { cookie: cookie(other.id) })).status, 404);

  const res = await post(prechargeCancelRoute, 'precharge/cancel', orderId, { cookie: cookie(sessionId) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'CANCELLED', canceled: true });
  const cancelled = await row(orderId);
  assert.equal(cancelled.captureCanceled, true);
  assert.equal(cancelled.status, 'CANCELLED');

  // Well past the delay, capture is still refused, and the notice cannot be rescheduled.
  assert.equal((await capturePayment(db, provider, sessionId, orderId, new Date(Date.now() + 3_600_000))).status, 409);
  assert.equal((await schedulePrecharge(db, sessionId, orderId)).status, 409);
  assert.deepEqual(calls, before);
  assert.equal((await audits(sessionId, 'prechargeCancel')).length, 1);
  // Idempotent.
  assert.equal((await post(prechargeCancelRoute, 'precharge/cancel', orderId, { cookie: cookie(sessionId) })).status, 200);
  assert.equal((await audits(sessionId, 'prechargeCancel')).length, 1);
});

test('pre-charge: a paid order cannot be cancelled from the notice', async () => {
  const { provider } = spy(createMockProvider());
  const { sessionId, orderId } = await awaitingPayment(provider);
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).body.status, 'PAID');
  assert.equal((await post(prechargeCancelRoute, 'precharge/cancel', orderId, { cookie: cookie(sessionId) })).status, 409);
  assert.equal((await schedulePrecharge(db, sessionId, orderId)).body.status, 'PAID');
  assert.equal((await row(orderId)).status, 'PAID');
});

// Spending policy (Layer 2).

test('policy: set by the session owner via the route, validated against Layer 1, tightening now, loosening after 24 h', async () => {
  const session = await createSession(db);
  await setIntent(db, session.id, { budgetCents: 4000, category: 'Camping', quantity: 2 });
  const put = (body: unknown, headers: Record<string, string> = { cookie: cookie(session.id) }) =>
    putPolicyRoute(new Request('http://localhost/api/policy', { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  const get = async () => await (await getPolicyRoute(new Request('http://localhost/api/policy', { headers: { cookie: cookie(session.id) } }))).json() as {
    policy: unknown; pending: unknown; isDefault: boolean; limits: { layer1: { hardCapCents: number }; bounds: { prechargeDelaySeconds: unknown }; cooldownHours: number };
  };
  const loaded = await get();
  assert.equal(loaded.isDefault, true);
  assert.deepEqual(loaded.policy, defaults);
  assert.equal(loaded.pending, null);
  assert.equal(loaded.limits.layer1.hardCapCents, 50_000);
  assert.deepEqual(loaded.limits.bounds.prechargeDelaySeconds, { min: 30, max: 600 });
  assert.equal(loaded.limits.cooldownHours, 24);

  const tightened = { ...defaults, requireApprovalAboveCents: 3000 };
  assert.equal((await put(tightened, {})).status, 401);
  assert.equal((await put(tightened, { cookie: cookie(session.id), origin: 'https://evil.example' })).status, 403);
  const tooHigh = await put({ ...defaults, perOrderMaxCents: 50_001 });
  assert.equal(tooHigh.status, 400);
  assert.ok(((await tooHigh.json()) as { issues: string[] }).issues.some(i => i.startsWith('perOrderMaxCents:')));
  assert.equal((await put({ ...defaults, allowedCategories: ['Weapons'] })).status, 400);
  assert.equal((await put({ ...defaults, timezone: 'Nowhere/City' })).status, 400);
  assert.equal(await db.sessionPolicy.count({ where: { sessionId: session.id } }), 0);

  const preview = async (sessionId = session.id) => { const s = await saveCart(db, sessionId, lanterns); assert.ok(s.ok); return s.preview; };
  assert.equal((await preview()).decision, 'ALLOW');
  const applied = await put(tightened);
  assert.equal(applied.status, 200);
  assert.equal(((await applied.json()) as { outcome: string }).outcome, 'APPLIED');
  const review = await preview();
  assert.equal(review.decision, 'NEEDS_APPROVAL');
  assert.deepEqual(review.reasons.map(r => `${r.layer}:${r.ruleId}`), ['2:policy-approval-threshold']);
  const [first] = await audits(session.id, 'setPolicy');
  assert.equal(first.outcome, 'APPLIED');
  assert.deepEqual(JSON.parse(first.detail).tightenedFields, ['requireApprovalAboveCents']);
  assert.equal(JSON.parse(first.detail).policy.requireApprovalAboveCents, 3000);

  // Another session keeps its own (default) policy.
  const other = await createSession(db);
  await setIntent(db, other.id, { budgetCents: 4000, category: 'Camping', quantity: 2 });
  assert.equal((await preview(other.id)).decision, 'ALLOW');

  // Loosening back to the defaults is held for 24 h: the effective policy does not change yet.
  const t0 = Date.now();
  const loosened = await put(defaults);
  const body = await loosened.json() as { outcome: string; loosenedFields: string[]; pending: { effectiveAt: string } };
  assert.equal(body.outcome, 'PENDING');
  assert.deepEqual(body.loosenedFields, ['requireApprovalAboveCents']);
  assert.ok(new Date(body.pending.effectiveAt).getTime() >= t0 + 24 * 3_600_000);
  assert.equal((await preview()).decision, 'NEEDS_APPROVAL');
  assert.notEqual((await get()).pending, null);
  const pendingAudit = (await audits(session.id, 'setPolicy')).find(a => a.outcome === 'PENDING')!;
  assert.deepEqual(JSON.parse(pendingAudit.detail).loosenedFields, ['requireApprovalAboveCents']);

  // Fake clock: not due after 23 h; promoted (and audited once) on the first read after 24 h.
  const early = await getPolicy(db, session.id, undefined, new Date(t0 + 23 * 3_600_000));
  assert.equal(early.policy.requireApprovalAboveCents, 3000);
  assert.notEqual(early.pending, null);
  const promoted = await getPolicy(db, session.id, undefined, new Date(t0 + 24 * 3_600_000 + 60_000));
  assert.deepEqual(promoted.policy, defaults);
  assert.equal(promoted.pending, null);
  assert.equal((await preview()).decision, 'ALLOW');
  assert.deepEqual((await audits(session.id, 'setPolicy')).map(a => a.outcome).sort(), ['APPLIED', 'PENDING', 'PROMOTED']);
});

test('policy: outside the allowed hours a cart is DENIED at checkout and refused at approval', async () => {
  const { provider, calls } = spy(createMockProvider());
  const ready = await sessionWithOrder(lanterns);
  assert.equal(ready.status, 'READY');
  // A one-hour window that excludes the current hour in the default time zone (a tightening, so it applies at once).
  const { hour } = localClock(new Date(), defaults.timezone);
  const window = { startHour: (hour + 2) % 24, endHour: (hour + 2) % 24 + 1 };
  assert.equal((await setPolicy(db, ready.sessionId, { ...defaults, allowedHours: window })).body.outcome, 'APPLIED');
  const refused = await decideOrder(db, provider, ready.sessionId, ready.orderId, 'APPROVED');
  assert.equal(refused.status, 409);
  assert.ok((refused.body.reasons as Reason[]).some(r => r.ruleId === 'policy-outside-hours' && r.layer === 2));
  assert.equal(calls.create, 0);
  await saveCart(db, ready.sessionId, lanterns);
  const denied = await submitCart(db, ready.sessionId);
  assert.ok(denied.ok);
  assert.equal(denied.status, 'DENIED');
});

test('Layer 1 at payment time: a duplicate cart is DENIED, and velocity stops the next approval before any provider call', async () => {
  const { provider, calls } = spy(createMockProvider());
  // Duplicate: the same cart again right after paying it.
  const paid = await awaitingPayment(provider);
  assert.equal((await capturePayment(db, provider, paid.sessionId, paid.orderId)).body.status, 'PAID');
  await saveCart(db, paid.sessionId, lanterns);
  const again = await submitCart(db, paid.sessionId);
  assert.ok(again.ok);
  assert.equal(again.status, 'DENIED');
  assert.ok(again.reasons.some(r => r.ruleId === 'duplicate-payment' && r.layer === 1));

  // Velocity: four READY orders created before any payment, then approved back to back. The fourth is refused.
  const session = await createSession(db);
  await setIntent(db, session.id, { budgetCents: 10_000, category: 'Camping', quantity: 2 });
  const ids: string[] = [];
  for (const productId of ['camp-06', 'camp-15', 'camp-13', 'camp-10']) {
    await saveCart(db, session.id, [{ productId, quantity: 2 }]);
    const submitted = await submitCart(db, session.id);
    assert.ok(submitted.ok);
    assert.equal(submitted.status, 'READY');
    ids.push(submitted.orderId);
  }
  for (const id of ids.slice(0, 3)) assert.equal((await decideOrder(db, provider, session.id, id, 'APPROVED')).status, 200);
  const createsBefore = calls.create;
  const blocked = await decideOrder(db, provider, session.id, ids[3], 'APPROVED');
  assert.equal(blocked.status, 409);
  assert.ok((blocked.body.reasons as Reason[]).some(r => r.ruleId === 'velocity-limit'));
  assert.equal(calls.create, createsBefore);
  assert.equal((await row(ids[3])).status, 'READY');
  assert.equal((await audits(session.id, 'humanReview')).filter(a => a.outcome === 'BLOCKED').length, 1);
});

test('Layer 1 at payment time: two simultaneous approvals of the same cart create only one payment', async () => {
  const { provider, calls } = spy(createMockProvider());
  const first = await sessionWithOrder(lanterns);
  const second = await submitCart(db, first.sessionId);
  assert.ok(second.ok);
  assert.deepEqual([first.status, second.status], ['READY', 'READY']);
  const createsBefore = calls.create;
  // The first approval is held inside the locked section until the second is seen waiting on the same advisory lock,
  // so the second can only run its re-check after the first has claimed and committed.
  const entered: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let firstLocked!: () => void;
  const locked = new Promise<void>(resolve => { firstLocked = resolve; });
  const firstResult = decideOrder(db, provider, first.sessionId, first.orderId, 'APPROVED', undefined, { onLocked: async () => { entered.push('first'); firstLocked(); await held; } });
  await locked;
  const secondResult = decideOrder(db, provider, first.sessionId, second.orderId, 'APPROVED', undefined, { onLocked: async () => { entered.push('second'); } });
  const key = `decideOrder:${first.sessionId}`;
  const waiting = async () => (await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtext(${key})::bigint & 4294967295)`)[0].n > 0;
  for (let tries = 0; !(await waiting()); tries++) {
    assert.ok(tries < 300, 'the second approval never waited on the advisory lock');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(entered, ['first']);
  release();
  const [approved, refused] = await Promise.all([firstResult, secondResult]);
  assert.deepEqual(entered, ['first', 'second']);
  assert.equal(approved.status, 200);
  assert.equal(refused.status, 409);
  assert.ok((refused.body.reasons as Reason[]).some(r => r.layer === 1 && ['duplicate-payment', 'velocity-limit'].includes(r.ruleId)));
  assert.equal(calls.create, createsBefore + 1);
  assert.deepEqual([(await row(first.orderId)).status, (await row(second.orderId)).status], ['AWAITING_PAYMENT', 'READY']);
});

test('policy: a save classified against a stale row is refused with 409 and does not overwrite a newer tightening', async () => {
  const session = await createSession(db);
  assert.equal((await setPolicy(db, session.id, defaults)).status, 200);
  // A tightening lands between the stale request's read and its write.
  const racing = new Proxy(db, {
    get(target, prop) {
      if (prop === '$transaction') return async (...args: unknown[]) => {
        assert.equal((await setPolicy(db, session.id, { ...defaults, perOrderMaxCents: 3000 })).body.outcome, 'APPLIED');
        return (target.$transaction as unknown as (...a: unknown[]) => unknown).apply(target, args);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const stale = await setPolicy(racing, session.id, { ...defaults, prechargeDelaySeconds: 30 });
  assert.equal(stale.status, 409);
  const { policy, pending } = await getPolicy(db, session.id);
  assert.deepEqual([policy.perOrderMaxCents, pending], [3000, null]);
  assert.deepEqual((await audits(session.id, 'setPolicy')).map(a => a.outcome), ['APPLIED', 'APPLIED']);
});

test('policy: daily max counts orders already committed today, and the approval recheck applies it', async () => {
  const { provider, calls } = spy(createMockProvider());
  const paid = await awaitingPayment(provider);
  assert.equal((await capturePayment(db, provider, paid.sessionId, paid.orderId)).body.status, 'PAID');
  assert.equal((await setPolicy(db, paid.sessionId, { ...defaults, dailyMaxCents: 5000 })).status, 200);
  const saved = await saveCart(db, paid.sessionId, [{ productId: 'camp-06', quantity: 2 }]);
  assert.ok(saved.ok);
  assert.equal(saved.preview.decision, 'DENY');
  assert.ok(saved.preview.reasons.some(r => r.rule === 'policy-daily-max' && r.outcome === 'DENY'));

  // A READY order whose policy was tightened afterwards is refused at approval, before any provider call.
  const ready = await sessionWithOrder([{ productId: 'camp-06', quantity: 2 }]);
  assert.equal(ready.status, 'READY');
  assert.equal((await setPolicy(db, ready.sessionId, { ...defaults, perOrderMaxCents: 3000 })).status, 200);
  const createsBefore = calls.create;
  assert.equal((await decideOrder(db, provider, ready.sessionId, ready.orderId, 'APPROVED')).status, 409);
  assert.equal(calls.create, createsBefore);
  assert.equal((await row(ready.orderId)).status, 'READY');
});
