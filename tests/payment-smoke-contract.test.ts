import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeCatalog } from '../src/server/catalog';
import { createPayPalClient, interpretCapture, loadPayPalConfig, PAYPAL_SANDBOX_API, PayPalError, priceCheckout } from '../src/server/payments/paypal';

const env = { PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: 'test-secret', PAYPAL_SANDBOX_MERCHANT_ID: 'SANDBOXMERCHANT1' };
const config = loadPayPalConfig(env);
const urls = { returnUrl: 'http://localhost:3000/?paypal=return', cancelUrl: 'http://localhost:3000/?paypal=cancel' };
const order = priceCheckout({ productId: 'camp-06', quantity: 3 }, runtimeCatalog(), 'ref-1');

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  };
  return { calls, fetchImpl };
}
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];
const networkError = () => { throw new TypeError('fetch failed'); };
const captured = (overrides: { status?: string; value?: string; currency?: string; merchantId?: string } = {}) => ({
  id: 'ORDER1', status: 'COMPLETED',
  purchase_units: [{ reference_id: 'ref-1', payee: { merchant_id: overrides.merchantId ?? 'SANDBOXMERCHANT1' },
    payments: { captures: [{ id: 'CAPTURE1', status: overrides.status ?? 'COMPLETED', amount: { currency_code: overrides.currency ?? 'USD', value: overrides.value ?? '56.97' } }] } }],
});
const expected = { referenceId: 'ref-1', totalCents: 5697, merchantId: 'SANDBOXMERCHANT1' };

test('paypal_payload_binding', async () => {
  const tampered = priceCheckout({ productId: 'camp-06', quantity: 3, amount: '0.01', currency: 'EUR', seller: 'attacker', payee: { merchant_id: 'EVIL' } }, runtimeCatalog(), 'ref-1');
  assert.deepEqual(tampered, order);
  const { calls, fetchImpl } = fakeFetch([() => Response.json({ id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED' })]);
  await createPayPalClient(config, fetchImpl).createOrder(tampered, urls, 'req-1');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.intent, 'CAPTURE');
  assert.equal(body.purchase_units.length, 1);
  assert.deepEqual(body.purchase_units[0].amount.currency_code, 'USD');
  assert.equal(body.purchase_units[0].amount.value, '56.97');
  assert.equal(body.purchase_units[0].payee.merchant_id, 'SANDBOXMERCHANT1');
  assert.throws(() => priceCheckout({ productId: 'camp-06', quantity: 6 }, runtimeCatalog(), 'ref-2'));
});

test('same_operation_same_request_id', async () => {
  const { calls, fetchImpl } = fakeFetch([networkError, () => new Response(null, { status: 503 }), () => Response.json(captured())]);
  await createPayPalClient(config, fetchImpl).captureOrder('ORDER1', 'capture-req-1');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => header(c, 'PayPal-Request-Id') === 'capture-req-1'));

  const failing = fakeFetch([networkError, networkError, networkError]);
  await assert.rejects(createPayPalClient(config, failing.fetchImpl).captureOrder('ORDER1', 'capture-req-2'),
    (error: unknown) => error instanceof PayPalError && error.outcomeUnknown);
  assert.ok(failing.calls.every(c => header(c, 'PayPal-Request-Id') === 'capture-req-2'));
});

test('payment_completion_uses_capture_status', () => {
  assert.equal(interpretCapture({ id: 'ORDER1', status: 'APPROVED', purchase_units: [{ reference_id: 'ref-1' }] }, expected).paid, false);
  assert.equal(interpretCapture({ id: 'ORDER1', status: 'COMPLETED', purchase_units: [{ reference_id: 'ref-1', payments: { captures: [] } }] }, expected).paid, false);
  assert.equal(interpretCapture(captured({ status: 'PENDING' }), expected).paid, false);
  assert.equal(interpretCapture(captured({ value: '0.01' }), expected).paid, false);
  assert.equal(interpretCapture(captured({ currency: 'EUR' }), expected).paid, false);
  assert.equal(interpretCapture(captured({ merchantId: 'OTHER' }), expected).paid, false);
  assert.deepEqual(interpretCapture(captured(), expected), { paid: true, captureId: 'CAPTURE1', amountCents: 5697 });
});

test('sandbox_only', async () => {
  assert.throws(() => loadPayPalConfig({ ...env, PAYPAL_API_BASE: 'https://api-m.paypal.com' }));
  assert.throws(() => loadPayPalConfig({ ...env, PAYPAL_ENV: 'live' }));
  assert.throws(() => loadPayPalConfig({ PAYPAL_CLIENT_ID: 'x' }));
  assert.equal(loadPayPalConfig({ ...env, PAYPAL_API_BASE: `${PAYPAL_SANDBOX_API}/` }).apiBase, PAYPAL_SANDBOX_API);
  const { calls, fetchImpl } = fakeFetch([() => Response.json(captured())]);
  await createPayPalClient(config, fetchImpl).getOrder('ORDER1');
  assert.ok(calls.every(c => c.url.startsWith(`${PAYPAL_SANDBOX_API}/`)));
  assert.throws(() => createPayPalClient(config, fetchImpl).getOrder('../../v1/evil'));
});
