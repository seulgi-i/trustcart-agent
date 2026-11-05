import { formatUsd, lineTotalCents } from '@/src/domain/money';
import { scanUntrusted } from '@/src/domain/scanner';
import type { RuntimeProduct } from '@/src/server/catalog';
import { HARD_CAP_CENTS, LAYER1_DEFAULTS, MAX_UNITS_PER_LINE, MONEY_MOVING, startOfUtcDay, startOfUtcMonth, type Layer1Limits } from '@/src/domain/layer1';
import { inAllowedHours, localClock, type SpendingPolicy } from '@/src/domain/spending-policy';

// Layer-1 hard limits live in layer1.ts; re-exported here for existing callers. A DENY can never be approved.
export { HARD_CAP_CENTS, MAX_UNITS_PER_LINE };

export type Intent = { budgetCents: number; category: string; quantity: number };
export type CartLine = { productId: string; quantity: number };
export type Decision = 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY';
// `rule` mirrors `ruleId` for callers written before the two-layer model.
export type Reason = { layer: 1 | 2; ruleId: string; rule: string; message: string; outcome: Exclude<Decision, 'ALLOW'>; expected?: string; actual?: string };
export type PricedLine = { productId: string; name: string; category: string; seller: string; quantity: number; unitCents: number; subtotalCents: number };
export type Evaluation = {
  decision: Decision;
  reasons: Reason[];
  scan: { productId: string; hits: string[] }[];
  diff: { budgetCents: [intent: number, cart: number]; quantity: [intent: number, cart: number]; category: [intent: string, cart: string[]] };
  lines: PricedLine[];
  totalCents: number;
};

// A payment this session already made or started (status in MONEY_MOVING), as loaded by the server. `at` is the
// order's last payment step (updatedAt), so an old READY order approved now counts as a payment now.
export type PaymentRecord = {
  orderId: string;
  status: string;
  totalCents: number;
  at: Date;
  lines: Pick<PricedLine, 'productId' | 'seller' | 'quantity' | 'subtotalCents'>[];
};

// Everything the payment-history and Layer-2 rules need. Optional so pure callers and the intent-only tests keep
// working; every server path that previews, creates or pays an order passes it (see evaluateCheckout in orders.ts).
export type PolicyContext = { policy: SpendingPolicy; history: PaymentRecord[]; now: Date; layer1?: Layer1Limits };

// Sorted productId:quantity of the merged cart. Two payments with the same fingerprint and total are duplicates.
export function cartFingerprint(lines: { productId: string; quantity: number }[]) {
  const merged = new Map<string, number>();
  for (const { productId, quantity } of lines) merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  return [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, q]) => `${id}:${q}`).join(',');
}

const minutesAgo = (now: Date, minutes: number) => now.getTime() - minutes * 60_000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function evaluateCart(intent: Intent, cart: CartLine[], catalog: RuntimeProduct[], ctx?: PolicyContext): Evaluation {
  const reasons: Reason[] = [];
  const add = (layer: 1 | 2, outcome: Reason['outcome']) => (ruleId: string, message: string, expected?: string, actual?: string) =>
    reasons.push({ layer, ruleId, rule: ruleId, message: message[0].toUpperCase() + message.slice(1), outcome, expected, actual });
  const deny = add(1, 'DENY');
  const review = add(1, 'NEEDS_APPROVAL');
  const userDeny = add(2, 'DENY');
  const userReview = add(2, 'NEEDS_APPROVAL');

  // --- Layer 1 (3): server-side price finalization. Merge duplicate lines first so splitting a product across lines
  // cannot dodge a per-line limit. Each input line's quantity is validated before merging, so 20 and -19 cannot
  // net out to a valid 1.
  const merged = new Map<string, number>();
  for (const { productId, quantity } of cart) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) { deny('invalid-quantity', `${productId} has quantity ${quantity}.`, '>= 1', `${productId}: ${quantity}`); continue; }
    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  }
  if (cart.length === 0) deny('empty-cart', 'the cart has no items.', '>= 1 item', '0 items');

  const lines: PricedLine[] = [];
  const scan: Evaluation['scan'] = [];
  for (const [productId, quantity] of merged) {
    const p = catalog.find(p => p.id === productId);
    if (!p) { deny('unknown-product', `${productId} is not in the catalog.`, 'catalog product', productId); continue; }
    if (quantity > MAX_UNITS_PER_LINE) { deny('max-units-per-line', `${p.id} has ${quantity} units; at most ${MAX_UNITS_PER_LINE} per line.`, `<= ${MAX_UNITS_PER_LINE}`, `${p.id}: ${quantity}`); continue; }
    if (quantity > p.stock) deny('out-of-stock', `${p.id} has ${p.stock} in stock, cart wants ${quantity}.`, `<= ${p.stock} in stock`, `${p.id}: ${quantity}`);
    const s = scanUntrusted(`${p.name}\n${p.seller}\n${p.description}`);
    if (s.flagged) scan.push({ productId: p.id, hits: s.hits });
    lines.push({ productId: p.id, name: p.name, category: p.category, seller: p.seller, quantity, unitCents: p.priceCents, subtotalCents: lineTotalCents(p.priceCents, quantity) });
  }

  const totalCents = sum(lines.map(l => l.subtotalCents));
  const units = sum(lines.map(l => l.quantity));
  const categories = [...new Set(lines.map(l => l.category))];
  if (totalCents > HARD_CAP_CENTS) deny('hard-budget-cap', `${formatUsd(totalCents)} is above the ${formatUsd(HARD_CAP_CENTS)} limit for one payment.`, `<= ${HARD_CAP_CENTS}c`, `${totalCents}c`);
  // --- Layer 1 (2): intent-vs-cart match.
  if (totalCents > intent.budgetCents) review('intent-budget', `${formatUsd(totalCents)} is above your ${formatUsd(intent.budgetCents)} budget.`, `<= ${intent.budgetCents}c`, `${totalCents}c`);
  if (units !== intent.quantity) review('intent-quantity', `${units} units, you asked for ${intent.quantity}.`, `${intent.quantity} units`, `${units} units`);
  const offCategory = categories.filter(c => c !== intent.category);
  if (offCategory.length) review('intent-category', `${offCategory.join(', ')} is not the requested ${intent.category}.`, intent.category, offCategory.join(', '));
  // --- Layer 1 (1): prompt-injection scan of seller text.
  for (const s of scan) review('injection-scanner', `${s.productId} contains suspicious instructions (${s.hits.join(', ')}).`, 'no suspicious instructions', `${s.productId}: ${s.hits.join(', ')}`);

  if (ctx) {
    const { policy, now } = ctx;
    const l1 = ctx.layer1 ?? LAYER1_DEFAULTS;
    const history = ctx.history.filter(r => (MONEY_MOVING as readonly string[]).includes(r.status));
    const since = (minutes: number) => history.filter(r => r.at.getTime() >= minutesAgo(now, minutes));

    // --- Layer 1 (4): velocity. This payment would be one more than the allowed count in the window.
    const velocity = since(l1.velocityWindowMinutes);
    if (velocity.length >= l1.velocityMax)
      deny('velocity-limit', `${velocity.length} payments already in the last ${l1.velocityWindowMinutes} minutes; at most ${l1.velocityMax} allowed.`, `<= ${l1.velocityMax} payments per ${l1.velocityWindowMinutes} min`, `${velocity.length + 1} payments`);

    // --- Layer 1 (5): split payment. Earlier payments in the window for the same product or the same seller, plus this
    // cart's share, would exceed what one payment may be.
    const splitPrior = since(l1.splitWindowMinutes).flatMap(r => r.lines);
    const splitHits: string[] = [];
    for (const key of ['productId', 'seller'] as const) {
      for (const value of new Set(lines.map(l => l[key]))) {
        const prior = sum(splitPrior.filter(l => l[key] === value).map(l => l.subtotalCents));
        const share = sum(lines.filter(l => l[key] === value).map(l => l.subtotalCents));
        if (prior > 0 && prior + share > l1.splitSingleLimitCents) splitHits.push(`${key === 'seller' ? 'seller' : 'product'} ${value}: ${formatUsd(prior)} earlier + ${formatUsd(share)} now`);
      }
    }
    if (splitHits.length)
      deny('split-payment', `${splitHits.join('; ')} in ${l1.splitWindowMinutes} minutes exceeds the ${formatUsd(l1.splitSingleLimitCents)} single-payment limit.`, `<= ${l1.splitSingleLimitCents}c per product/seller per ${l1.splitWindowMinutes} min`, splitHits.join('; '));

    // --- Layer 1 (6): duplicate payment. Same cart and amount again within the window.
    const fingerprint = cartFingerprint(lines);
    const duplicate = since(l1.duplicateWindowMinutes).find(r => r.totalCents === totalCents && cartFingerprint(r.lines) === fingerprint);
    if (duplicate)
      deny('duplicate-payment', `the same cart for ${formatUsd(totalCents)} was already paid or is being paid (order ${duplicate.orderId}) in the last ${l1.duplicateWindowMinutes} minutes.`, 'no identical payment in window', duplicate.orderId);

    // --- Layer 1 (7): daily and monthly hard caps (UTC), committed money plus this cart.
    const spentToday = sum(history.filter(r => r.at >= startOfUtcDay(now)).map(r => r.totalCents));
    const spentMonth = sum(history.filter(r => r.at >= startOfUtcMonth(now)).map(r => r.totalCents));
    const overDailyHard = spentToday + totalCents > l1.dailyHardCapCents;
    if (overDailyHard) deny('daily-hard-cap', `${formatUsd(spentToday)} today + ${formatUsd(totalCents)} exceeds the ${formatUsd(l1.dailyHardCapCents)} system daily cap.`, `<= ${l1.dailyHardCapCents}c per UTC day`, `${spentToday}c committed + ${totalCents}c`);
    if (spentMonth + totalCents > l1.monthlyHardCapCents) deny('monthly-hard-cap', `${formatUsd(spentMonth)} this month + ${formatUsd(totalCents)} exceeds the ${formatUsd(l1.monthlyHardCapCents)} system monthly cap.`, `<= ${l1.monthlyHardCapCents}c per UTC month`, `${spentMonth}c committed + ${totalCents}c`);

    // --- Layer 2: the user's settings. Money caps and the time window are DENY; the approval threshold and the
    // category list send to review. Rules already covered by a stricter cap are skipped to keep reasons readable.
    if (totalCents <= HARD_CAP_CENTS && totalCents > policy.perOrderMaxCents) userDeny('policy-per-order-max', `${formatUsd(totalCents)} is above your ${formatUsd(policy.perOrderMaxCents)} per-order maximum.`, `<= ${policy.perOrderMaxCents}c`, `${totalCents}c`);
    for (const category of categories) {
      if (!Object.hasOwn(policy.perCategoryMaxCents, category)) continue;
      const max = policy.perCategoryMaxCents[category];
      const spent = sum(lines.filter(l => l.category === category).map(l => l.subtotalCents));
      if (spent > max) userDeny('policy-category-max', `${formatUsd(spent)} of ${category} is above your ${formatUsd(max)} limit for it.`, `<= ${max}c ${category}`, `${spent}c`);
    }
    if (!overDailyHard && spentToday + totalCents > policy.dailyMaxCents) userDeny('policy-daily-max', `${formatUsd(spentToday)} today + ${formatUsd(totalCents)} exceeds your ${formatUsd(policy.dailyMaxCents)} daily maximum.`, `<= ${policy.dailyMaxCents}c per UTC day`, `${spentToday}c committed + ${totalCents}c`);

    let clock: { hour: number; weekday: number } | null = null;
    try { clock = localClock(now, policy.timezone); } catch { /* invalid zone: fail closed below */ }
    const hours = `${policy.allowedHours.startHour}:00-${policy.allowedHours.endHour}:00 ${policy.timezone}`;
    if (!clock || !inAllowedHours(clock.hour, policy.allowedHours)) userDeny('policy-outside-hours', `payments are allowed ${hours}; it is ${clock ? `${clock.hour}:xx` : 'an unknown time'} there now.`, hours, clock ? `${clock.hour}:xx` : 'invalid time zone');
    if (!clock || !policy.allowedWeekdays.includes(clock.weekday)) userDeny('policy-outside-weekdays', `payments are not allowed on this weekday in ${policy.timezone}.`, `weekday in [${policy.allowedWeekdays.join(',')}]`, clock ? String(clock.weekday) : 'invalid time zone');

    const orderCap = Math.min(policy.perOrderMaxCents, HARD_CAP_CENTS);
    if (totalCents <= orderCap && totalCents > policy.requireApprovalAboveCents) userReview('policy-approval-threshold', `${formatUsd(totalCents)} is above ${formatUsd(policy.requireApprovalAboveCents)}, so you review it.`, `<= ${policy.requireApprovalAboveCents}c without review`, `${totalCents}c`);
    const blocked = categories.filter(c => !policy.allowedCategories.includes(c));
    if (blocked.length) userReview('policy-category', `${blocked.join(', ')} is not in your allowed categories.`, policy.allowedCategories.join(', ') || '(none)', blocked.join(', '));
  }

  const decision: Decision = reasons.some(r => r.outcome === 'DENY') ? 'DENY' : reasons.length ? 'NEEDS_APPROVAL' : 'ALLOW';
  return { decision, reasons, scan, diff: { budgetCents: [intent.budgetCents, totalCents], quantity: [intent.quantity, units], category: [intent.category, categories] }, lines, totalCents };
}
