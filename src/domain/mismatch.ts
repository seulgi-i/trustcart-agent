import { lineTotalCents } from '@/src/domain/money';
import type { MandateCart } from '@/src/domain/mandate';

// Demo only: simulates what a merchant fulfilled and billed, then compares it with the signed mandate. Real billing
// data would come from the merchant; the comparison is the same.

export const MISMATCH_SCENARIOS = ['none', 'extra_quantity', 'hidden_fee', 'price_change'] as const;
export type MismatchScenario = (typeof MISMATCH_SCENARIOS)[number];
export const SCENARIO_LABELS: Record<MismatchScenario, string> = {
  none: 'Billed as approved',
  extra_quantity: 'Extra quantity (one more unit of the first item)',
  hidden_fee: 'Hidden shipping fee',
  price_change: 'Price change on the first item',
};
export const HIDDEN_FEE_CENTS = 799;

export type DiffEntry = { field: string; expected: string | number | null; actual: string | number | null };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function simulateBilling(cart: MandateCart, scenario: MismatchScenario): MandateCart {
  const items = cart.items.map(i => ({ ...i }));
  const [first] = items;
  let { shippingCents } = cart;
  if (first && scenario === 'extra_quantity') first.quantity += 1;
  // +10% of the unit price, at least $1.00.
  if (first && scenario === 'price_change') first.unitCents += Math.max(100, Math.round(first.unitCents / 10));
  if (first) first.subtotalCents = lineTotalCents(first.unitCents, first.quantity);
  if (scenario === 'hidden_fee') shippingCents += HIDDEN_FEE_CENTS;
  const itemTotalCents = sum(items.map(i => i.subtotalCents));
  return { ...cart, items, itemTotalCents, shippingCents, totalCents: itemTotalCents + shippingCents };
}

// Every field that differs, in a fixed order: merchant, currency, then each item (mandate order, then extra billed
// items; for an item in both, what was sold — name, seller, category — before the amounts), then the totals. An empty
// list means the billing matches the mandate. The same product ID sold under another name, by another seller or in
// another category is a substitution, so it is a difference even when the amounts match.
export function diffBilling(expected: MandateCart, actual: MandateCart): DiffEntry[] {
  const diff: DiffEntry[] = [];
  const compare = (field: string, e: string | number | null, a: string | number | null) => { if (e !== a) diff.push({ field, expected: e, actual: a }); };
  compare('merchant', expected.merchant, actual.merchant);
  compare('currency', expected.currency, actual.currency);
  const ids = [...new Set([...expected.items, ...actual.items].map(i => i.productId))];
  for (const id of ids) {
    const e = expected.items.find(i => i.productId === id);
    const a = actual.items.find(i => i.productId === id);
    if (!a || !e) { compare(`items[${id}]`, e ? `${e.quantity} x ${e.name}` : null, a ? `${a.quantity} x ${a.name}` : null); continue; }
    for (const key of ['name', 'seller', 'category', 'quantity', 'unitCents', 'subtotalCents'] as const) compare(`items[${id}].${key}`, e[key], a[key]);
  }
  compare('itemTotalCents', expected.itemTotalCents, actual.itemTotalCents);
  compare('shippingCents', expected.shippingCents, actual.shippingCents);
  compare('totalCents', expected.totalCents, actual.totalCents);
  return diff;
}

// What was billed beyond the mandate: the suggested partial refund.
export const overchargeCents = (expected: MandateCart, actual: MandateCart) => Math.max(0, actual.totalCents - expected.totalCents);
