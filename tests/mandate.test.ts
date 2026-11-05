import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { LAYER1_DEFAULTS } from '../src/domain/layer1';
import { buildMandatePayload, canonicalJson, MANDATE_TYPE, policySourceLabel, RECONSTRUCTED_POLICY_NOTE, type MandateInput } from '../src/domain/mandate';
import { evaluateCart } from '../src/domain/policy';
import { defaultSpendingPolicy } from '../src/domain/spending-policy';
import { runtimeCatalog } from '../src/server/catalog';
import { loadMandateSigner, signMandate, verifyMandate, verifySignature } from '../src/server/mandate';

const intent = { budgetCents: 4000, category: 'Camping', quantity: 2 };
const cart = [{ productId: 'camp-06', quantity: 2, reason: 'Cheapest rechargeable lantern with no scanner hits.' }];
const evaluation = evaluateCart(intent, cart, runtimeCatalog());
const input: MandateInput = {
  policySource: 'payment_time_snapshot',
  order: { id: 'order-1', totalCents: evaluation.totalCents, createdAt: new Date('2026-11-05T10:00:00Z'), captureScheduledAt: new Date('2026-11-05T10:01:00Z'), provider: 'mock', providerOrderId: 'MOCK-ORDER', cartJson: JSON.stringify(cart), evaluation },
  intent: { ...intent, createdAt: new Date('2026-11-05T09:59:00Z') },
  captureId: 'MOCK-CAPTURE', capturedCents: evaluation.totalCents,
  policy: defaultSpendingPolicy(['Camping', 'Household']), layer1: LAYER1_DEFAULTS, capturedAt: new Date('2026-11-05T10:02:00Z'),
};
const payload = buildMandatePayload(input);
const signer = loadMandateSigner({ NODE_ENV: 'test' });
const expected = { orderId: 'order-1', captureId: 'MOCK-CAPTURE' };

test('canonical JSON: keys sorted at every level, undefined dropped, order of arrays kept', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined, x: null }], c: 'é' } }), '{"a":{"c":"é","d":[3,{"x":null,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ n: Number.NaN }));
  // Round trip: parsing and re-serializing gives the same bytes.
  const json = canonicalJson(payload);
  assert.equal(canonicalJson(JSON.parse(json)), json);
});

test('mandate payload carries intent, approved cart, selection reasons, policy, timestamps and PayPal IDs', () => {
  assert.equal(payload.type, MANDATE_TYPE);
  assert.deepEqual(payload.intent, intent);
  assert.equal(payload.cart.merchant, 'Field Works via mock provider');
  assert.deepEqual(payload.cart.items.map(i => [i.productId, i.quantity, i.unitCents, i.subtotalCents]), [['camp-06', 2, 1899, 3798]]);
  assert.deepEqual([payload.cart.itemTotalCents, payload.cart.shippingCents, payload.cart.totalCents], [3798, 0, 3798]);
  assert.equal(payload.selection[0].agentReason, cart[0].reason);
  assert.ok(payload.selection[0].serverChecks.some(c => c.includes('matches the requested Camping')));
  assert.equal(payload.policy.source, 'payment_time_snapshot');
  assert.equal(payload.policy.note, undefined);
  assert.equal(payload.policy.decision, 'ALLOW');
  assert.equal(payload.policy.layer1.hardCapCents, 50_000);
  assert.equal(payload.policy.layer2.prechargeDelaySeconds, 60);
  assert.deepEqual(payload.payment, { provider: 'mock', providerOrderId: 'MOCK-ORDER', captureId: 'MOCK-CAPTURE', capturedCents: 3798, currency: 'USD' });
  assert.equal(payload.timestamps.capturedAt, '2026-11-05T10:02:00.000Z');
});

test('policy source: a reconstructed policy is marked and labelled as not the payment-time policy', () => {
  const reconstructed = buildMandatePayload({ ...input, policySource: 'reconstructed_at_recovery' });
  assert.equal(reconstructed.policy.source, 'reconstructed_at_recovery');
  assert.equal(reconstructed.policy.note, RECONSTRUCTED_POLICY_NOTE);
  assert.match(RECONSTRUCTED_POLICY_NOTE, /^Not the payment-time policy/);
  // The marker is signed with the rest: stripping it breaks the signature.
  const signed = signMandate(signer, reconstructed);
  const stripped = canonicalJson({ ...reconstructed, policy: { ...reconstructed.policy, source: undefined, note: undefined } });
  assert.equal(verifySignature(stripped, signed.signature, signer.publicKey), false);

  assert.deepEqual(policySourceLabel(payload.policy), { reconstructed: false, label: 'Payment-time snapshot (taken when the payment was approved)' });
  const label = policySourceLabel(reconstructed.policy);
  assert.equal(label.reconstructed, true);
  assert.match(label.label, /^Reconstructed at recovery\. Not the payment-time policy/);
  // A mandate stored before the field existed is never presented as a payment-time snapshot.
  assert.equal(policySourceLabel({}).reconstructed, true);
});

test('signature verifies; any change to the payload or signature fails (tamper detection)', () => {
  const signed = signMandate(signer, payload);
  assert.equal(signed.publicKeyFingerprint, signer.fingerprint);
  assert.match(signer.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(verifySignature(signed.payload, signed.signature, signer.publicKey), true);
  assert.deepEqual(verifyMandate(signed, signer, expected), { valid: true, checks: { signature: true, keyFingerprint: true, canonical: true, orderBinding: true }, publicKeyFingerprint: signer.fingerprint });

  // Billed 3 instead of 2: the canonical bytes change, so the signature no longer verifies.
  const tamperedPayload = canonicalJson({ ...payload, cart: { ...payload.cart, items: [{ ...payload.cart.items[0], quantity: 3 }] } });
  const tampered = verifyMandate({ ...signed, payload: tamperedPayload }, signer, expected);
  assert.equal(tampered.valid, false);
  assert.equal(tampered.checks.signature, false);
  // A one-character edit anywhere fails too.
  assert.equal(verifySignature(signed.payload.replace('3798', '3799'), signed.signature, signer.publicKey), false);
  // A corrupted signature fails, and so does garbage.
  const sig = Buffer.from(signed.signature, 'base64');
  sig[0] ^= 1;
  assert.equal(verifySignature(signed.payload, sig.toString('base64'), signer.publicKey), false);
  assert.equal(verifySignature(signed.payload, 'not-a-signature', signer.publicKey), false);
  // Bound to its order and capture: a valid mandate presented for another order is not valid there.
  assert.equal(verifyMandate(signed, signer, { orderId: 'order-2', captureId: 'MOCK-CAPTURE' }).checks.orderBinding, false);
  // Whitespace changes are refused as non-canonical even before the signature check.
  assert.equal(verifyMandate({ ...signed, payload: JSON.stringify(JSON.parse(signed.payload), null, 1) }, signer, expected).checks.canonical, false);
});

test('a mandate signed with another key does not verify under the server key', () => {
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const otherSigner = loadMandateSigner({ MANDATE_SIGNING_KEY: Buffer.from(other).toString('base64') });
  assert.equal(otherSigner.dev, false);
  assert.notEqual(otherSigner.fingerprint, signer.fingerprint);
  const result = verifyMandate(signMandate(otherSigner, payload), signer, expected);
  assert.deepEqual([result.valid, result.checks.signature, result.checks.keyFingerprint], [false, false, false]);
  assert.equal(verifyMandate(signMandate(otherSigner, payload), otherSigner, expected).valid, true);
});

test('signing key: env PKCS8 PEM, stable dev key outside production, fail closed in production', () => {
  // The development key is derived, so it is the same across restarts and mandates stay verifiable.
  assert.equal(loadMandateSigner({}).fingerprint, signer.fingerprint);
  assert.equal(signer.dev, true);
  assert.throws(() => loadMandateSigner({ NODE_ENV: 'production' }), /MANDATE_SIGNING_KEY/);
  assert.throws(() => loadMandateSigner({ NODE_ENV: 'production', MANDATE_SIGNING_KEY: '  ' }), /MANDATE_SIGNING_KEY/);
  assert.throws(() => loadMandateSigner({ MANDATE_SIGNING_KEY: Buffer.from('not a key').toString('base64') }), /PKCS8 PEM/);
  // Not Ed25519: refused. The error never echoes the key.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => loadMandateSigner({ NODE_ENV: 'production', MANDATE_SIGNING_KEY: Buffer.from(rsa).toString('base64') }), (e: unknown) => e instanceof Error && /Ed25519/.test(e.message) && !e.message.includes('PRIVATE KEY'));
  const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const prod = loadMandateSigner({ NODE_ENV: 'production', MANDATE_SIGNING_KEY: Buffer.from(ed).toString('base64') });
  assert.equal(prod.dev, false);
  assert.match(prod.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
});
