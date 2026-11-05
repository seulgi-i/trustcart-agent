import { lineTotalCents } from '@/src/domain/money';
import { scanUntrusted } from '@/src/domain/scanner';
import type { RuntimeProduct } from '@/src/server/catalog';

// Hard limits are server constants. No user, intent or model output can raise them, and a DENY cannot be approved.
export const HARD_CAP_CENTS = 50_000;
export const MAX_UNITS_PER_LINE = 20;

export type Intent = { budgetCents: number; category: string; quantity: number };
export type CartLine = { productId: string; quantity: number };
export type Decision = 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY';
export type Reason = { rule: string; outcome: Exclude<Decision, 'ALLOW'>; expected: string; actual: string };
export type PricedLine = { productId: string; name: string; category: string; seller: string; quantity: number; unitCents: number; subtotalCents: number };
export type Evaluation = {
  decision: Decision;
  reasons: Reason[];
  scan: { productId: string; hits: string[] }[];
  diff: { budgetCents: [intent: number, cart: number]; quantity: [intent: number, cart: number]; category: [intent: string, cart: string[]] };
  lines: PricedLine[];
  totalCents: number;
};

export function evaluateCart(intent: Intent, cart: CartLine[], catalog: RuntimeProduct[]): Evaluation {
  const reasons: Reason[] = [];
  const deny = (rule: string, expected: string, actual: string) => reasons.push({ rule, outcome: 'DENY', expected, actual });
  const review = (rule: string, expected: string, actual: string) => reasons.push({ rule, outcome: 'NEEDS_APPROVAL', expected, actual });

  // Merge duplicate lines first so splitting a product across lines cannot dodge a per-line limit.
  const merged = new Map<string, number>();
  for (const { productId, quantity } of cart) merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  if (merged.size === 0) deny('empty-cart', '>= 1 item', '0 items');

  const lines: PricedLine[] = [];
  const scan: Evaluation['scan'] = [];
  for (const [productId, quantity] of merged) {
    const p = catalog.find(p => p.id === productId);
    if (!p) { deny('unknown-product', 'catalog product', productId); continue; }
    if (!Number.isSafeInteger(quantity) || quantity < 1) { deny('invalid-quantity', '>= 1', `${p.id}: ${quantity}`); continue; }
    if (quantity > MAX_UNITS_PER_LINE) { deny('max-units-per-line', `<= ${MAX_UNITS_PER_LINE}`, `${p.id}: ${quantity}`); continue; }
    if (quantity > p.stock) deny('out-of-stock', `<= ${p.stock} in stock`, `${p.id}: ${quantity}`);
    const s = scanUntrusted(`${p.name}\n${p.seller}\n${p.description}`);
    if (s.flagged) scan.push({ productId: p.id, hits: s.hits });
    lines.push({ productId: p.id, name: p.name, category: p.category, seller: p.seller, quantity, unitCents: p.priceCents, subtotalCents: lineTotalCents(p.priceCents, quantity) });
  }

  const totalCents = lines.reduce((sum, l) => sum + l.subtotalCents, 0);
  const units = lines.reduce((sum, l) => sum + l.quantity, 0);
  const categories = [...new Set(lines.map(l => l.category))];
  if (totalCents > HARD_CAP_CENTS) deny('hard-budget-cap', `<= ${HARD_CAP_CENTS}c`, `${totalCents}c`);
  if (totalCents > intent.budgetCents) review('intent-budget', `<= ${intent.budgetCents}c`, `${totalCents}c`);
  if (units !== intent.quantity) review('intent-quantity', `${intent.quantity} units`, `${units} units`);
  const offCategory = categories.filter(c => c !== intent.category);
  if (offCategory.length) review('intent-category', intent.category, offCategory.join(', '));
  for (const s of scan) review('injection-scanner', 'no suspicious instructions', `${s.productId}: ${s.hits.join(', ')}`);

  const decision: Decision = reasons.some(r => r.outcome === 'DENY') ? 'DENY' : reasons.length ? 'NEEDS_APPROVAL' : 'ALLOW';
  return { decision, reasons, scan, diff: { budgetCents: [intent.budgetCents, totalCents], quantity: [intent.quantity, units], category: [intent.category, categories] }, lines, totalCents };
}
