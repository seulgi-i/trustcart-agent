import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cartFingerprint, evaluateCart, HARD_CAP_CENTS, type CartLine, type Intent, type PaymentRecord } from '../src/domain/policy';
import { LAYER1_DEFAULTS, layer1Limits, startOfUtcMonth, type Layer1Limits } from '../src/domain/layer1';
import {
  classifyPolicyChange, cooldownEnds, defaultSpendingPolicy, inAllowedHours, localClock, makeSpendingPolicySchema, pendingIsDue,
  spendingPolicySchema, startOfUtcDay, type SpendingPolicy,
} from '../src/domain/spending-policy';
import { describeReason } from '../src/domain/rule-labels';
import { runtimeCatalog } from '../src/server/catalog';
import { createShoppingTools } from '../lib/agent';

const catalog = runtimeCatalog();
const intent: Intent = { budgetCents: 4000, category: 'Camping', quantity: 2 };
const defaults = defaultSpendingPolicy(catalog.map(p => p.category));
const lanterns: CartLine[] = [{ productId: 'camp-06', quantity: 2 }]; // 3798c, Field Works, matches the intent
// Thursday 2026-11-05 15:00 UTC = 10:00 in New York (EST) = Friday 00:00 in Seoul.
const NOW = new Date('2026-11-05T15:00:00Z');
const minutesBefore = (m: number, now = NOW) => new Date(now.getTime() - m * 60_000);

type Opts = { policy?: Partial<SpendingPolicy>; history?: PaymentRecord[]; now?: Date; layer1?: Partial<Layer1Limits>; intent?: Intent };
const evaluate = (cart: CartLine[] = lanterns, o: Opts = {}) =>
  evaluateCart(o.intent ?? intent, cart, catalog, { policy: { ...defaults, ...o.policy }, history: o.history ?? [], now: o.now ?? NOW, layer1: { ...LAYER1_DEFAULTS, ...o.layer1 } });
const rules = (e: ReturnType<typeof evaluate>) => e.reasons.map(r => `${r.outcome}:${r.ruleId}`);

// A past payment of `cart`, priced from the catalog like a real order's evaluation.
let seq = 0;
function payment(cart: CartLine[], at: Date, status = 'PAID'): PaymentRecord {
  const { lines, totalCents } = evaluateCart(intent, cart, catalog);
  return { orderId: `order-${++seq}`, status, totalCents, at, lines };
}
const lump = (totalCents: number, at: Date): PaymentRecord => ({ orderId: `order-${++seq}`, status: 'PAID', totalCents, at, lines: [] });

// --- Defaults and reason shape ------------------------------------------------------------------------------------

test('defaults keep the Layer-1 limits, allow every category, all hours and days, 60 s pre-charge', () => {
  assert.deepEqual(defaults, {
    perOrderMaxCents: HARD_CAP_CENTS, dailyMaxCents: 4 * HARD_CAP_CENTS, allowedCategories: ['Camping', 'Household'], perCategoryMaxCents: {},
    requireApprovalAboveCents: HARD_CAP_CENTS, allowedHours: { startHour: 0, endHour: 24 }, allowedWeekdays: [0, 1, 2, 3, 4, 5, 6],
    timezone: 'America/New_York', prechargeDelaySeconds: 60,
  });
  const e = evaluate();
  assert.equal(e.decision, 'ALLOW');
  assert.deepEqual(e.reasons, []);
});

test('every reason carries layer, ruleId, message (and rule for older callers) and renders as "Layer n · label"', () => {
  const e = evaluate([{ productId: 'camp-03', quantity: 10 }], { policy: { allowedHours: { startHour: 0, endHour: 1 } } });
  for (const r of e.reasons) {
    assert.ok(r.layer === 1 || r.layer === 2);
    assert.equal(r.rule, r.ruleId);
    assert.ok(r.message.length > 0);
  }
  const titles = e.reasons.map(r => describeReason(r).title);
  assert.ok(titles.includes('Layer 1 · Prompt-injection scan'), titles.join(' | '));
  assert.ok(titles.includes('Layer 2 · Outside allowed hours'), titles.join(' | '));
  // Orders stored before the two-layer model still render.
  assert.equal(describeReason({ rule: 'policy-daily-max', expected: 'a', actual: 'b' }).title, 'Layer 2 · Daily maximum');
});

// --- Layer 2 rules --------------------------------------------------------------------------------------------------

test('Layer 2: requireApprovalAboveCents sends to review; 0 reviews every order', () => {
  assert.deepEqual(rules(evaluate(lanterns, { policy: { requireApprovalAboveCents: 3000 } })), ['NEEDS_APPROVAL:policy-approval-threshold']);
  assert.equal(evaluate(lanterns, { policy: { requireApprovalAboveCents: 0 } }).decision, 'NEEDS_APPROVAL');
  assert.equal(evaluate(lanterns, { policy: { requireApprovalAboveCents: 3798 } }).decision, 'ALLOW');
});

test('Layer 2: per-order, per-category and daily maximums are DENY', () => {
  assert.deepEqual(rules(evaluate(lanterns, { policy: { perOrderMaxCents: 3000 } })), ['DENY:policy-per-order-max']);
  assert.deepEqual(rules(evaluate(lanterns, { policy: { perCategoryMaxCents: { Camping: 3000 } } })), ['DENY:policy-category-max']);
  assert.equal(evaluate(lanterns, { policy: { perCategoryMaxCents: { Household: 100 } } }).decision, 'ALLOW');
  // Payments in progress or paid today count: 197_000 + 3798 > 200_000. Yesterday's do not.
  assert.deepEqual(rules(evaluate(lanterns, { history: [lump(197_000, minutesBefore(120))] })), ['DENY:policy-daily-max']);
  assert.equal(evaluate(lanterns, { history: [lump(197_000, new Date('2026-11-04T23:00:00Z'))] }).decision, 'ALLOW');
  // The policy cannot lift the hard cap.
  assert.ok(rules(evaluate([{ productId: 'camp-09', quantity: 3 }])).includes('DENY:hard-budget-cap'));
});

test('Layer 2: a category outside allowedCategories is NEEDS_APPROVAL', () => {
  assert.deepEqual(rules(evaluate(lanterns, { policy: { allowedCategories: ['Household'] } })), ['NEEDS_APPROVAL:policy-category']);
});

// Required test 7.
test('Layer 2: time-window block outside allowed hours or weekdays is DENY, in the user time zone', () => {
  const hours = (startHour: number, endHour: number) => ({ policy: { allowedHours: { startHour, endHour } } });
  // 15:00 UTC = 10:00 New York.
  assert.equal(evaluate(lanterns, hours(9, 17)).decision, 'ALLOW');
  assert.deepEqual(rules(evaluate(lanterns, { ...hours(9, 17), now: new Date('2026-11-05T23:00:00Z') })), ['DENY:policy-outside-hours']); // 18:00
  assert.deepEqual(rules(evaluate(lanterns, hours(11, 17))), ['DENY:policy-outside-hours']); // 10:00, start inclusive
  assert.deepEqual(rules(evaluate(lanterns, hours(8, 10))), ['DENY:policy-outside-hours']); // end exclusive
  // Overnight 22-6.
  assert.deepEqual(rules(evaluate(lanterns, hours(22, 6))), ['DENY:policy-outside-hours']);
  assert.equal(evaluate(lanterns, { ...hours(22, 6), now: new Date('2026-11-06T03:00:00Z') }).decision, 'ALLOW'); // 22:00
  // Weekdays: Saturday in New York is blocked by Mon-Fri.
  const weekdays = { allowedWeekdays: [1, 2, 3, 4, 5] };
  assert.equal(evaluate(lanterns, { policy: weekdays }).decision, 'ALLOW');
  assert.deepEqual(rules(evaluate(lanterns, { policy: weekdays, now: new Date('2026-11-07T15:00:00Z') })), ['DENY:policy-outside-weekdays']);
  // Same instant in Seoul is Friday 00:00: allowed on Friday, blocked by 9-17.
  assert.equal(evaluate(lanterns, { policy: { timezone: 'Asia/Seoul', allowedWeekdays: [5] } }).decision, 'ALLOW');
  assert.deepEqual(rules(evaluate(lanterns, { policy: { timezone: 'Asia/Seoul', allowedHours: { startHour: 9, endHour: 17 } } })), ['DENY:policy-outside-hours']);
  // A corrupt zone fails closed.
  assert.equal(evaluate(lanterns, { policy: { timezone: 'Not/AZone' } }).decision, 'DENY');
});

test('time helpers: local clock, windows, UTC day/month', () => {
  assert.deepEqual(localClock(NOW, 'America/New_York'), { hour: 10, weekday: 4 });
  assert.deepEqual(localClock(NOW, 'Asia/Seoul'), { hour: 0, weekday: 5 });
  assert.deepEqual(localClock(new Date('2026-11-05T05:00:00Z'), 'UTC'), { hour: 5, weekday: 4 });
  assert.ok(inAllowedHours(0, { startHour: 0, endHour: 24 }) && inAllowedHours(23, { startHour: 0, endHour: 24 }));
  assert.ok(inAllowedHours(23, { startHour: 22, endHour: 6 }) && inAllowedHours(5, { startHour: 22, endHour: 6 }) && !inAllowedHours(6, { startHour: 22, endHour: 6 }));
  assert.ok(!inAllowedHours(3, { startHour: 0, endHour: 0 }));
  assert.equal(startOfUtcDay(new Date('2026-11-05T23:59:59Z')).toISOString(), '2026-11-05T00:00:00.000Z');
  assert.equal(startOfUtcMonth(new Date('2026-11-05T23:59:59Z')).toISOString(), '2026-11-01T00:00:00.000Z');
});

// --- Layer 1 history rules ------------------------------------------------------------------------------------------

const bigIntent: Intent = { budgetCents: 50_000, category: 'Camping', quantity: 2 };

// Required test 1.
test('Layer 1: split-payment attack (small payments, same product or seller, short window) is DENY', () => {
  // Same product: two earlier tent payments (one still in flight) + this one = 3 x 179.98 > 500 single-payment limit.
  const tents: CartLine[] = [{ productId: 'camp-01', quantity: 2 }];
  const history = [payment(tents, minutesBefore(25)), payment(tents, minutesBefore(15), 'AWAITING_PAYMENT')];
  const e = evaluate(tents, { intent: bigIntent, history });
  assert.equal(e.decision, 'DENY');
  assert.deepEqual(rules(e), ['DENY:split-payment']);
  assert.match(e.reasons[0].message, /Product camp-01/);
  assert.equal(e.reasons[0].layer, 1);
  // Each payment alone is under every cap.
  assert.equal(evaluate(tents, { intent: bigIntent }).decision, 'ALLOW');
  // Same seller, different products: 3 tents (269.97) then 2 x... chairs from Trail Supply.
  const sameSeller = evaluate([{ productId: 'camp-02', quantity: 8 }], { intent: { ...bigIntent, quantity: 8 }, history: [payment([{ productId: 'camp-01', quantity: 3 }], minutesBefore(40))] });
  assert.deepEqual(rules(sameSeller), ['DENY:split-payment']);
  assert.match(sameSeller.reasons[0].message, /Seller Trail Supply/);
  // Outside the window, failed or cancelled payments do not count.
  assert.equal(evaluate(tents, { intent: bigIntent, history: history.map(h => ({ ...h, at: minutesBefore(61) })) }).decision, 'ALLOW');
  assert.equal(evaluate(tents, { intent: bigIntent, history: history.map(h => ({ ...h, status: 'CANCELLED' })) }).decision, 'ALLOW');
  // The limit is a Layer-1 setting (LAYER1_SPLIT_SINGLE_LIMIT_CENTS).
  assert.deepEqual(rules(evaluate(lanterns, { history: [payment([{ productId: 'camp-04', quantity: 1 }], minutesBefore(5))], layer1: { splitSingleLimitCents: 5000 } })), ['DENY:split-payment']);
});

// Required test 2.
test('Layer 1: velocity attack (rapid consecutive payments) is DENY', () => {
  const recent = [
    payment([{ productId: 'home-01', quantity: 1 }], minutesBefore(20)),
    payment([{ productId: 'camp-10', quantity: 1 }], minutesBefore(10), 'CAPTURING'),
  ];
  const cart: CartLine[] = [{ productId: 'camp-15', quantity: 2 }];
  // Two payments in 30 minutes: the third is allowed.
  assert.equal(evaluate(cart, { history: recent }).decision, 'ALLOW');
  // A third payment in flight: the fourth is denied.
  const three = [...recent, payment([{ productId: 'camp-04', quantity: 1 }], minutesBefore(1), 'PAYMENT_CREATING')];
  const e = evaluate(cart, { history: three });
  assert.deepEqual(rules(e), ['DENY:velocity-limit']);
  assert.equal(e.reasons[0].actual, '4 payments');
  // Rejected/failed orders are not payments; older ones fall out of the window.
  assert.equal(evaluate(cart, { history: [...recent, { ...three[2], status: 'FAILED' }] }).decision, 'ALLOW');
  assert.equal(evaluate(cart, { history: three.map(h => ({ ...h, at: minutesBefore(31) })) }).decision, 'ALLOW');
});

// Required test 3.
test('Layer 1: duplicate payment (same cart and amount within the window) is DENY', () => {
  const earlier = payment(lanterns, minutesBefore(5));
  assert.deepEqual(rules(evaluate(lanterns, { history: [earlier] })), ['DENY:duplicate-payment']);
  // Splitting the same cart across lines does not change its fingerprint.
  assert.deepEqual(rules(evaluate([{ productId: 'camp-06', quantity: 1 }, { productId: 'camp-06', quantity: 1 }], { history: [earlier] })), ['DENY:duplicate-payment']);
  assert.equal(cartFingerprint([{ productId: 'b', quantity: 1 }, { productId: 'a', quantity: 2 }]), 'a:2,b:1');
  // Different cart, or the same cart after the window: not a duplicate.
  assert.equal(evaluate([{ productId: 'camp-15', quantity: 2 }], { history: [earlier] }).decision, 'ALLOW');
  assert.equal(evaluate(lanterns, { history: [{ ...earlier, at: minutesBefore(11) }] }).decision, 'ALLOW');
});

// Required test 4.
test('Layer 1: monthly hard cap is DENY (and daily hard cap), over committed money this UTC month', () => {
  const l1 = LAYER1_DEFAULTS;
  const monthly = evaluate(lanterns, { history: [lump(l1.monthlyHardCapCents - 3000, new Date('2026-11-02T12:00:00Z'))] });
  assert.equal(monthly.decision, 'DENY');
  assert.deepEqual(rules(monthly), ['DENY:monthly-hard-cap']);
  // Last month's payments do not count.
  assert.equal(evaluate(lanterns, { history: [lump(l1.monthlyHardCapCents - 3000, new Date('2026-10-31T23:00:00Z'))] }).decision, 'ALLOW');
  // Daily hard cap: the Layer-2 daily rule is not repeated under it.
  assert.deepEqual(rules(evaluate(lanterns, { history: [lump(l1.dailyHardCapCents - 3000, minutesBefore(120))], policy: { dailyMaxCents: l1.dailyHardCapCents } })), ['DENY:daily-hard-cap']);
});

test('Layer-1 limits from env: safe defaults, invalid values ignored, split <= hard cap, monthly >= daily', () => {
  assert.deepEqual(layer1Limits({} as NodeJS.ProcessEnv), LAYER1_DEFAULTS);
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
  const l = layer1Limits(env({ LAYER1_VELOCITY_MAX: ' 5 ', LAYER1_VELOCITY_WINDOW_MINUTES: '-1', LAYER1_SPLIT_SINGLE_LIMIT_CENTS: '999999', LAYER1_DAILY_HARD_CAP_CENTS: '800000', LAYER1_MONTHLY_HARD_CAP_CENTS: '100', LAYER1_DUPLICATE_WINDOW_MINUTES: 'abc' }));
  assert.equal(l.velocityMax, 5);
  assert.equal(l.velocityWindowMinutes, LAYER1_DEFAULTS.velocityWindowMinutes);
  assert.equal(l.splitSingleLimitCents, HARD_CAP_CENTS);
  assert.equal(l.monthlyHardCapCents, 800_000);
  assert.equal(l.duplicateWindowMinutes, LAYER1_DEFAULTS.duplicateWindowMinutes);
  assert.equal(l.hardCapCents, HARD_CAP_CENTS);
  assert.ok(LAYER1_DEFAULTS.monthlyHardCapCents >= LAYER1_DEFAULTS.dailyHardCapCents && LAYER1_DEFAULTS.dailyHardCapCents >= defaults.dailyMaxCents);
});

// --- Zod (required test 6) ------------------------------------------------------------------------------------------

test('the policy schema rejects out-of-range and dangerous values against the Layer-1 bounds, with clear issues', () => {
  assert.ok(spendingPolicySchema.safeParse(defaults).success);
  assert.ok(spendingPolicySchema.safeParse({ ...defaults, perCategoryMaxCents: { Camping: 5000 }, allowedHours: { startHour: 22, endHour: 6 }, allowedWeekdays: [1], timezone: 'Asia/Seoul', prechargeDelaySeconds: 600 }).success);
  const bad: unknown[] = [
    null, {}, 'policy',
    { ...defaults, perOrderMaxCents: HARD_CAP_CENTS + 1 },
    { ...defaults, perOrderMaxCents: 0 },
    { ...defaults, perOrderMaxCents: 10.5 },
    { ...defaults, perOrderMaxCents: '100' },
    { ...defaults, dailyMaxCents: LAYER1_DEFAULTS.dailyHardCapCents + 1 },
    { ...defaults, dailyMaxCents: -1 },
    { ...defaults, requireApprovalAboveCents: -1 },
    { ...defaults, requireApprovalAboveCents: HARD_CAP_CENTS + 1 },
    { ...defaults, allowedCategories: [] },
    { ...defaults, allowedCategories: ['Camping', 'Camping'] },
    { ...defaults, allowedCategories: [''] },
    { ...defaults, perCategoryMaxCents: { Camping: HARD_CAP_CENTS + 1 } },
    { ...defaults, perCategoryMaxCents: { Camping: 0 } },
    { ...defaults, perOrderMaxCents: 1000, perCategoryMaxCents: { Camping: 2000 } },
    { ...defaults, allowedCategories: ['Camping'], perCategoryMaxCents: { Household: 100 } },
    { ...defaults, allowedHours: { startHour: 24, endHour: 24 } },
    { ...defaults, allowedHours: { startHour: 9, endHour: 9 } },
    { ...defaults, allowedHours: { startHour: -1, endHour: 5 } },
    { ...defaults, allowedHours: { startHour: 9, endHour: 25 } },
    { ...defaults, allowedHours: { startHour: 9 } },
    { ...defaults, allowedWeekdays: [] },
    { ...defaults, allowedWeekdays: [7] },
    { ...defaults, allowedWeekdays: [1, 1] },
    { ...defaults, timezone: 'Mars/Olympus' },
    { ...defaults, timezone: '' },
    { ...defaults, prechargeDelaySeconds: 29 },
    { ...defaults, prechargeDelaySeconds: 601 },
    { ...defaults, prechargeDelaySeconds: 0 },
    { ...defaults, maxQuantity: 5 },
    { ...defaults, hardCapCents: 9_999_999 },
  ];
  for (const payload of bad) assert.equal(spendingPolicySchema.safeParse(payload).success, false, JSON.stringify(payload));
  const issue = spendingPolicySchema.safeParse({ ...defaults, perOrderMaxCents: HARD_CAP_CENTS + 1 });
  assert.ok(!issue.success && issue.error.issues.some(i => i.path[0] === 'perOrderMaxCents' && /Layer-1 hard cap/.test(i.message)));
  // Bounds follow the Layer-1 limits in force.
  assert.equal(makeSpendingPolicySchema({ ...LAYER1_DEFAULTS, dailyHardCapCents: 100_000 }).safeParse(defaults).success, false);
});

// --- Cool-down (required test 5) ------------------------------------------------------------------------------------

test('cool-down: tightening applies now, loosening waits, mixed changes split per field', () => {
  const base: SpendingPolicy = { ...defaults, perOrderMaxCents: 10_000, dailyMaxCents: 20_000, requireApprovalAboveCents: 5_000, allowedCategories: ['Camping'], allowedHours: { startHour: 9, endHour: 17 }, allowedWeekdays: [1, 2, 3, 4, 5], perCategoryMaxCents: { Camping: 5_000 } };

  const tighter = classifyPolicyChange(base, { ...base, perOrderMaxCents: 8_000, prechargeDelaySeconds: 120 });
  assert.deepEqual(tighter.tightenedFields.sort(), ['perOrderMaxCents', 'prechargeDelaySeconds']);
  assert.deepEqual(tighter.loosenedFields, []);
  assert.deepEqual(tighter.immediate, { ...base, perOrderMaxCents: 8_000, prechargeDelaySeconds: 120 });

  const looser = classifyPolicyChange(base, { ...base, dailyMaxCents: 40_000, requireApprovalAboveCents: 9_000, prechargeDelaySeconds: 30 });
  assert.deepEqual(looser.loosenedFields.sort(), ['dailyMaxCents', 'prechargeDelaySeconds', 'requireApprovalAboveCents']);
  assert.deepEqual(looser.tightenedFields, []);
  assert.deepEqual(looser.immediate, base);

  // Mixed: lower per-order applies; added category, Saturday and shorter delay wait.
  const mixed = classifyPolicyChange(base, { ...base, perOrderMaxCents: 6_000, allowedCategories: ['Camping', 'Household'], allowedWeekdays: [1, 2, 3, 4, 5, 6], prechargeDelaySeconds: 30 });
  assert.deepEqual(mixed.tightenedFields, ['perOrderMaxCents']);
  assert.deepEqual(mixed.loosenedFields.sort(), ['allowedCategories', 'allowedWeekdays', 'prechargeDelaySeconds']);
  assert.deepEqual(mixed.immediate, { ...base, perOrderMaxCents: 6_000 });

  // Within one field: the overlap applies now.
  const swap = classifyPolicyChange(base, { ...base, allowedCategories: ['Household'], perCategoryMaxCents: {} });
  assert.deepEqual(swap.immediate.allowedCategories, []);
  assert.ok(swap.tightenedFields.includes('allowedCategories') && swap.loosenedFields.includes('allowedCategories'));
  assert.deepEqual(swap.immediate.perCategoryMaxCents, { Camping: 5_000 }); // removing a limit loosens
  const shift = classifyPolicyChange(base, { ...base, allowedHours: { startHour: 12, endHour: 20 } });
  assert.deepEqual(shift.immediate.allowedHours, { startHour: 12, endHour: 17 });
  const overnight = classifyPolicyChange({ ...base, allowedHours: { startHour: 22, endHour: 6 } }, { ...base, allowedHours: { startHour: 0, endHour: 24 } });
  assert.deepEqual(overnight.loosenedFields, ['allowedHours']);
  assert.deepEqual(overnight.immediate.allowedHours, { startHour: 22, endHour: 6 });
  const caps = classifyPolicyChange(base, { ...base, perCategoryMaxCents: { Camping: 3_000 } });
  assert.deepEqual([caps.tightenedFields, caps.loosenedFields, caps.immediate.perCategoryMaxCents], [['perCategoryMaxCents'], [], { Camping: 3_000 }]);

  // Time zone: immediate when nothing is time-restricted, otherwise it waits.
  assert.equal(classifyPolicyChange(defaults, { ...defaults, timezone: 'Asia/Seoul' }).immediate.timezone, 'Asia/Seoul');
  const tz = classifyPolicyChange(base, { ...base, timezone: 'Asia/Seoul' });
  assert.deepEqual([tz.loosenedFields, tz.immediate.timezone], [['timezone'], base.timezone]);

  // The narrowed immediate policy really is stricter: a Household cart goes to review until the change is promoted.
  assert.equal(evaluate([{ productId: 'home-01', quantity: 2 }], { intent: { ...intent, category: 'Household' }, policy: swap.immediate }).decision, 'NEEDS_APPROVAL');
});

test('cool-down: a pending change is due 24 h later on a fake clock, not before', () => {
  const requestedAt = NOW;
  const effectiveAt = cooldownEnds(requestedAt);
  assert.equal(effectiveAt.toISOString(), '2026-11-06T15:00:00.000Z');
  assert.equal(pendingIsDue(effectiveAt, new Date(effectiveAt.getTime() - 1)), false);
  assert.equal(pendingIsDue(effectiveAt, effectiveAt), true);
  assert.equal(pendingIsDue(null, new Date('2030-01-01T00:00:00Z')), false);
});

// --- Agent (required test 9) ----------------------------------------------------------------------------------------

test('the agent has no tool that writes the policy', () => {
  assert.deepEqual(Object.keys(createShoppingTools('x'.repeat(43))).sort(), ['buildCart', 'checkout', 'searchProducts']);
  const source = readFileSync('lib/agent.ts', 'utf8');
  assert.doesNotMatch(source, /setPolicy|sessionPolicy|spending-policy|layer1/);
});
