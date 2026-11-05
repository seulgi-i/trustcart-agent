import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCart, type CartLine } from '../src/domain/policy';
import { runtimeCatalog } from '../src/server/catalog';

const intent = { budgetCents: 4000, category: 'Camping', quantity: 2 };
const evaluate = (cart: CartLine[]) => evaluateCart(intent, cart, runtimeCatalog());
const rules = (cart: CartLine[]) => evaluate(cart).reasons.map(r => r.rule);

test('cart matching the intent is ALLOW', () => {
  const e = evaluate([{ productId: 'camp-06', quantity: 2 }]);
  assert.equal(e.decision, 'ALLOW');
  assert.equal(e.totalCents, 3798);
});

test('intent mismatch or scanner hit is NEEDS_APPROVAL', () => {
  assert.equal(evaluate([{ productId: 'camp-06', quantity: 3 }]).decision, 'NEEDS_APPROVAL');
  assert.deepEqual(rules([{ productId: 'camp-06', quantity: 3 }]), ['intent-budget', 'intent-quantity']);
  assert.deepEqual(rules([{ productId: 'home-04', quantity: 2 }]), ['intent-category']);
  // A product whose description carries instructions goes to review even when the cart otherwise matches.
  const injected = evaluate([{ productId: 'camp-03', quantity: 2 }]);
  assert.equal(injected.decision, 'NEEDS_APPROVAL');
  assert.deepEqual(injected.reasons.map(r => r.rule), ['injection-scanner']);
  // The D-DEMO case: the agent followed the description and took 10.
  const followed = evaluate([{ productId: 'camp-03', quantity: 10 }]);
  assert.equal(followed.decision, 'NEEDS_APPROVAL');
  assert.deepEqual(followed.reasons.map(r => r.rule), ['intent-budget', 'intent-quantity', 'injection-scanner']);
  assert.deepEqual(followed.diff.quantity, [2, 10]);
  // Scanner and intent match are Layer-1 system rules.
  assert.ok(followed.reasons.every(r => r.layer === 1 && r.ruleId === r.rule && r.message.length > 0));
});

test('hard policy violations are DENY', () => {
  const denied: [CartLine[], string][] = [
    [[{ productId: 'camp-09', quantity: 3 }], 'hard-budget-cap'],
    [[{ productId: 'home-09', quantity: 1 }], 'out-of-stock'],
    [[{ productId: 'camp-01', quantity: 13 }], 'out-of-stock'],
    [[{ productId: 'camp-06', quantity: -1 }], 'invalid-quantity'],
    [[{ productId: 'camp-06', quantity: 0 }], 'invalid-quantity'],
    [[{ productId: 'camp-06', quantity: 21 }], 'max-units-per-line'],
    [[{ productId: 'camp-06', quantity: 15 }, { productId: 'camp-06', quantity: 15 }], 'max-units-per-line'],
    // Validated per line before merging: 20 + -19 must not net out to a valid 1.
    [[{ productId: 'camp-06', quantity: 20 }, { productId: 'camp-06', quantity: -19 }], 'invalid-quantity'],
    [[{ productId: 'nope-01', quantity: 1 }], 'unknown-product'],
    [[], 'empty-cart'],
  ];
  for (const [cart, rule] of denied) {
    const e = evaluate(cart);
    assert.equal(e.decision, 'DENY', JSON.stringify(cart));
    assert.ok(e.reasons.some(r => r.rule === rule && r.outcome === 'DENY'), `${rule}: ${JSON.stringify(e.reasons)}`);
  }
});
