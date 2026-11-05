import test from 'node:test';
import assert from 'node:assert/strict';
import type { MandateCart } from '../src/domain/mandate';
import { diffBilling, HIDDEN_FEE_CENTS, MISMATCH_SCENARIOS, overchargeCents, simulateBilling } from '../src/domain/mismatch';

const cart: MandateCart = {
  merchant: 'Field Works via mock provider', currency: 'USD',
  items: [
    { productId: 'camp-06', name: 'Rechargeable LED Lantern', seller: 'Field Works', category: 'Camping', quantity: 2, unitCents: 1899, subtotalCents: 3798 },
    { productId: 'camp-10', name: 'Tent Stakes', seller: 'Field Works', category: 'Camping', quantity: 1, unitCents: 500, subtotalCents: 500 },
  ],
  itemTotalCents: 4298, shippingCents: 0, totalCents: 4298,
};

test('none: billing matches the mandate, empty diff, no overcharge', () => {
  const billed = simulateBilling(cart, 'none');
  assert.deepEqual(billed, cart);
  assert.deepEqual(diffBilling(cart, billed), []);
  assert.equal(overchargeCents(cart, billed), 0);
});

test('extra_quantity: ordered 2, billed 3', () => {
  const billed = simulateBilling(cart, 'extra_quantity');
  assert.deepEqual(diffBilling(cart, billed), [
    { field: 'items[camp-06].quantity', expected: 2, actual: 3 },
    { field: 'items[camp-06].subtotalCents', expected: 3798, actual: 5697 },
    { field: 'itemTotalCents', expected: 4298, actual: 6197 },
    { field: 'totalCents', expected: 4298, actual: 6197 },
  ]);
  assert.equal(overchargeCents(cart, billed), 1899);
});

test('hidden_fee: a shipping fee that was never approved', () => {
  const billed = simulateBilling(cart, 'hidden_fee');
  assert.deepEqual(diffBilling(cart, billed), [
    { field: 'shippingCents', expected: 0, actual: HIDDEN_FEE_CENTS },
    { field: 'totalCents', expected: 4298, actual: 4298 + HIDDEN_FEE_CENTS },
  ]);
  assert.equal(overchargeCents(cart, billed), HIDDEN_FEE_CENTS);
});

test('price_change: unit price raised by 10% (at least $1.00)', () => {
  const billed = simulateBilling(cart, 'price_change');
  assert.deepEqual(diffBilling(cart, billed), [
    { field: 'items[camp-06].unitCents', expected: 1899, actual: 2089 },
    { field: 'items[camp-06].subtotalCents', expected: 3798, actual: 4178 },
    { field: 'itemTotalCents', expected: 4298, actual: 4678 },
    { field: 'totalCents', expected: 4298, actual: 4678 },
  ]);
  assert.equal(overchargeCents(cart, billed), 380);
  const cheap = { ...cart, items: [{ ...cart.items[1] }], itemTotalCents: 500, totalCents: 500 };
  assert.equal(simulateBilling(cheap, 'price_change').items[0].unitCents, 600);
});

test('diff reports missing, extra and merchant differences; the input cart is never mutated', () => {
  const snapshot = structuredClone(cart);
  for (const s of MISMATCH_SCENARIOS) simulateBilling(cart, s);
  assert.deepEqual(cart, snapshot);
  const swapped: MandateCart = { ...cart, merchant: 'Someone Else', items: [cart.items[0], { ...cart.items[1], productId: 'camp-99', name: 'Other' }] };
  assert.deepEqual(diffBilling(cart, swapped), [
    { field: 'merchant', expected: cart.merchant, actual: 'Someone Else' },
    { field: 'items[camp-10]', expected: '1 x Tent Stakes', actual: null },
    { field: 'items[camp-99]', expected: null, actual: '1 x Other' },
  ]);
  // The same product ID sold under another name, by another seller or in another category is a difference, even at
  // the same price; so is a different merchant on the billing.
  const substituted: MandateCart = {
    ...cart, merchant: 'Knockoff Co via mock provider',
    items: [{ ...cart.items[0], name: 'Generic Lantern', seller: 'Knockoff Co', category: 'Household' }, cart.items[1]],
  };
  assert.deepEqual(diffBilling(cart, substituted), [
    { field: 'merchant', expected: cart.merchant, actual: 'Knockoff Co via mock provider' },
    { field: 'items[camp-06].name', expected: 'Rechargeable LED Lantern', actual: 'Generic Lantern' },
    { field: 'items[camp-06].seller', expected: 'Field Works', actual: 'Knockoff Co' },
    { field: 'items[camp-06].category', expected: 'Camping', actual: 'Household' },
  ]);
  assert.deepEqual(diffBilling(cart, { ...cart, items: [{ ...cart.items[0], seller: 'Knockoff Co' }, cart.items[1]] }), [
    { field: 'items[camp-06].seller', expected: 'Field Works', actual: 'Knockoff Co' },
  ]);
  assert.equal(overchargeCents(cart, substituted), 0);
  // Billed less than approved is a difference but not an overcharge.
  assert.equal(overchargeCents(cart, { ...cart, totalCents: 100 }), 0);
});
