import { z } from 'zod';
import { LAYER1_DEFAULTS, startOfUtcDay, type Layer1Limits } from '@/src/domain/layer1';

// Layer 2: the user's spending policy, edited only on the /policy page (never by the agent, which has no tool for it).
// Every bound sits inside the Layer-1 system limits, so a policy can only tighten them, never raise them.

export const DEFAULT_TIMEZONE = 'America/New_York';
export const PRECHARGE_DELAY = { min: 30, max: 600, default: 60 } as const;
// Loosening a setting waits this long before it takes effect; tightening applies at once.
export const COOLDOWN_HOURS = 24;

export type AllowedHours = { startHour: number; endHour: number };
export type SpendingPolicy = {
  perOrderMaxCents: number;
  dailyMaxCents: number;
  allowedCategories: string[];
  // Optional cap per allowed category (cents of that category in one cart). A category without an entry is limited
  // only by perOrderMaxCents.
  perCategoryMaxCents: Record<string, number>;
  requireApprovalAboveCents: number;
  // Local time in `timezone`. endHour is exclusive; startHour > endHour is an overnight window (22-6 = 22:00-05:59);
  // 0-24 is all day. startHour === endHour is rejected on input and stored only to mean "no hours" (see below).
  allowedHours: AllowedHours;
  allowedWeekdays: number[]; // 0 = Sunday .. 6 = Saturday, by the local date in `timezone`
  timezone: string; // IANA name
  prechargeDelaySeconds: number;
};
export type PolicyField = keyof SpendingPolicy;

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

// A session without a saved policy gets these. They add nothing the Layer-1 limits do not already enforce, apart
// from the daily cap, so the demo behaves as before until the user tightens something.
export function defaultSpendingPolicy(categories: string[], l1: Layer1Limits = LAYER1_DEFAULTS): SpendingPolicy {
  return {
    perOrderMaxCents: l1.hardCapCents,
    dailyMaxCents: Math.min(4 * l1.hardCapCents, l1.dailyHardCapCents),
    allowedCategories: [...new Set(categories)].sort(),
    perCategoryMaxCents: {},
    requireApprovalAboveCents: l1.hardCapCents,
    allowedHours: { startHour: 0, endHour: 24 },
    allowedWeekdays: ALL_WEEKDAYS,
    timezone: DEFAULT_TIMEZONE,
    prechargeDelaySeconds: PRECHARGE_DELAY.default,
  };
}

// Suggested values shown next to each field on /policy. Not enforced.
export const RECOMMENDED = {
  perOrderMaxCents: 10_000,
  dailyMaxCents: 25_000,
  requireApprovalAboveCents: 5_000,
  allowedHours: { startHour: 8, endHour: 22 },
  prechargeDelaySeconds: PRECHARGE_DELAY.default,
};

export function isValidTimeZone(tz: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const unique = (a: unknown[]) => new Set(a).size === a.length;

// Write-side validation against the Layer-1 limits in force. Strict: unknown keys (e.g. a hardCapCents) are rejected.
// That categories exist in the catalog is checked by the server against the database.
export function makeSpendingPolicySchema(l1: Layer1Limits = LAYER1_DEFAULTS) {
  const cents = (max: number, label: string) => z.number().int().positive().max(max, `${label} must be at most ${max} cents`);
  const hour = z.number().int();
  return z.strictObject({
    perOrderMaxCents: cents(l1.hardCapCents, 'Per-order maximum (Layer-1 hard cap)'),
    dailyMaxCents: cents(l1.dailyHardCapCents, 'Daily maximum (Layer-1 daily hard cap)'),
    allowedCategories: z.array(z.string().min(1).max(40)).min(1).max(20).refine(unique, 'Categories must be unique'),
    perCategoryMaxCents: z.record(z.string().min(1).max(40), cents(l1.hardCapCents, 'Category maximum (Layer-1 hard cap)'))
      .refine(r => Object.keys(r).length <= 20, 'At most 20 category limits'),
    requireApprovalAboveCents: z.number().int().min(0).max(l1.hardCapCents, `Approval threshold must be at most ${l1.hardCapCents} cents`),
    allowedHours: z.strictObject({ startHour: hour.min(0).max(23), endHour: hour.min(1).max(24) })
      .refine(h => h.startHour !== h.endHour, 'Start and end hour must differ (use 0-24 for all day)'),
    allowedWeekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Allow at least one weekday').max(7).refine(unique, 'Weekdays must be unique'),
    timezone: z.string().min(1).max(64).refine(isValidTimeZone, 'Unknown IANA time zone'),
    prechargeDelaySeconds: z.number().int().min(PRECHARGE_DELAY.min).max(PRECHARGE_DELAY.max),
  }).superRefine((p, ctx) => {
    for (const [category, max] of Object.entries(p.perCategoryMaxCents ?? {})) {
      if (!p.allowedCategories?.includes(category)) ctx.addIssue({ code: 'custom', path: ['perCategoryMaxCents', category], message: 'Limit set for a category that is not allowed' });
      else if (max > p.perOrderMaxCents) ctx.addIssue({ code: 'custom', path: ['perCategoryMaxCents', category], message: 'Category maximum cannot exceed the per-order maximum' });
    }
  });
}
export const spendingPolicySchema = makeSpendingPolicySchema();

// --- Time window -------------------------------------------------------------------------------------------------

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Local hour (0-23) and weekday (0 = Sunday) of `now` in an IANA zone. Intl only, no extra dependency.
export function localClock(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  return {
    hour: Number(parts.find(p => p.type === 'hour')?.value) % 24,
    weekday: WEEKDAY.indexOf(parts.find(p => p.type === 'weekday')?.value ?? ''),
  };
}

// startHour === endHour never passes input validation; internally it means "no allowed hours" (see tightenHours).
export function inAllowedHours(hour: number, { startHour, endHour }: AllowedHours) {
  if (startHour === endHour) return false;
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

const hourMask = (h: AllowedHours) => Array.from({ length: 24 }, (_, i) => inAllowedHours(i, h));

// Turns an hour mask back into one window. If the hours are not a single (possibly overnight) run, the longest run
// is kept: stricter than asked, which is the safe direction while a cool-down is pending.
function windowFromMask(mask: boolean[]): AllowedHours {
  if (mask.every(Boolean)) return { startHour: 0, endHour: 24 };
  if (!mask.some(Boolean)) return { startHour: 0, endHour: 0 };
  let best = { start: 0, length: 0 };
  const off = mask.indexOf(false);
  for (let i = 1, start = -1, length = 0; i <= 24; i++) {
    const h = (off + i) % 24;
    if (mask[h]) { if (start < 0) start = h; length++; if (length > best.length) best = { start, length }; }
    else { start = -1; length = 0; }
  }
  const end = best.start + best.length;
  return { startHour: best.start, endHour: end === 24 ? 24 : end % 24 };
}

// --- Cool-down on loosening ----------------------------------------------------------------------------------------

export type PolicyChange = {
  // What applies now: the effective policy with every tightening applied and every loosening held back.
  immediate: SpendingPolicy;
  tightenedFields: PolicyField[];
  loosenedFields: PolicyField[];
};

const sameSet = (a: unknown[], b: unknown[]) => a.length === b.length && a.every(x => b.includes(x));
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRestricted = (p: SpendingPolicy) => !sameSet(p.allowedWeekdays, ALL_WEEKDAYS) || hourMask(p.allowedHours).some(x => !x);

// Compares a requested policy with the effective one, field by field. A field loosens when it lets through anything
// the effective value would not: a higher money cap or approval threshold, a shorter pre-charge delay, an added
// category, weekday or hour, or a category limit raised or removed. Partial changes inside a field are split: the
// stricter part (e.g. the categories in both lists, the lower of two category limits) applies now.
export function classifyPolicyChange(effective: SpendingPolicy, requested: SpendingPolicy): PolicyChange {
  const immediate: SpendingPolicy = { ...effective };
  const tightenedFields: PolicyField[] = [];
  const loosenedFields: PolicyField[] = [];
  const mark = (field: PolicyField, tighter: boolean, looser: boolean) => {
    if (tighter) tightenedFields.push(field);
    if (looser) loosenedFields.push(field);
  };

  // Higher is looser.
  for (const field of ['perOrderMaxCents', 'dailyMaxCents', 'requireApprovalAboveCents'] as const) {
    mark(field, requested[field] < effective[field], requested[field] > effective[field]);
    immediate[field] = Math.min(requested[field], effective[field]);
  }
  // Shorter is looser.
  mark('prechargeDelaySeconds', requested.prechargeDelaySeconds > effective.prechargeDelaySeconds, requested.prechargeDelaySeconds < effective.prechargeDelaySeconds);
  immediate.prechargeDelaySeconds = Math.max(requested.prechargeDelaySeconds, effective.prechargeDelaySeconds);

  // More is looser. The overlap applies now (it may be empty: then every cart goes to review / no day is allowed).
  const overlap = <T,>(field: PolicyField, eff: T[], req: T[]) => {
    mark(field, eff.some(x => !req.includes(x)), req.some(x => !eff.includes(x)));
    return eff.filter(x => req.includes(x));
  };
  immediate.allowedCategories = overlap('allowedCategories', effective.allowedCategories, requested.allowedCategories);
  immediate.allowedWeekdays = overlap('allowedWeekdays', effective.allowedWeekdays, requested.allowedWeekdays);

  const effMask = hourMask(effective.allowedHours);
  const reqMask = hourMask(requested.allowedHours);
  mark('allowedHours', effMask.some((on, h) => on && !reqMask[h]), reqMask.some((on, h) => on && !effMask[h]));
  immediate.allowedHours = sameJson(effMask, reqMask) ? requested.allowedHours : windowFromMask(effMask.map((on, h) => on && reqMask[h]));

  // A limit removed or raised is looser; added or lowered is tighter. The lower value applies now.
  const caps: Record<string, number> = {};
  let capsTighter = false, capsLooser = false;
  for (const category of new Set([...Object.keys(effective.perCategoryMaxCents), ...Object.keys(requested.perCategoryMaxCents)])) {
    const eff = effective.perCategoryMaxCents[category];
    const req = requested.perCategoryMaxCents[category];
    if (req !== undefined && (eff === undefined || req < eff)) capsTighter = true;
    if (eff !== undefined && (req === undefined || req > eff)) capsLooser = true;
    caps[category] = Math.min(eff ?? Infinity, req ?? Infinity);
  }
  mark('perCategoryMaxCents', capsTighter, capsLooser);
  immediate.perCategoryMaxCents = caps;

  // A time zone shifts the window, so it can only be called tighter or looser case by case. It applies at once only
  // when neither policy restricts hours or weekdays (nothing to shift); otherwise it waits like a loosening.
  if (requested.timezone !== effective.timezone) {
    if (isRestricted(effective) || isRestricted(requested)) loosenedFields.push('timezone');
    else immediate.timezone = requested.timezone;
  }

  return { immediate, tightenedFields, loosenedFields };
}

export const cooldownEnds = (now: Date) => new Date(now.getTime() + COOLDOWN_HOURS * 3_600_000);

// Lazy promotion, decided purely so it can be tested with a fake clock: a pending change whose time has come
// replaces the effective policy.
export function pendingIsDue(pendingEffectiveAt: Date | null, now: Date) {
  return pendingEffectiveAt !== null && pendingEffectiveAt.getTime() <= now.getTime();
}

export { startOfUtcDay };
