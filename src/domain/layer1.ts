// Layer 1: system limits. Server constants plus operator env, read on the server only. No user, policy, intent or
// model output can disable or raise them; the /policy page shows them read-only and Layer-2 settings must fit inside.
export const HARD_CAP_CENTS = 50_000;
export const MAX_UNITS_PER_LINE = 20;

// Statuses where money is moving or has moved. These are the payments counted by velocity, split-payment,
// duplicate and daily/monthly caps. READY/NEEDS_APPROVAL (nothing created yet) and DENIED/REJECTED/CANCELLED/FAILED
// (nothing charged) do not count.
export const MONEY_MOVING = ['PAYMENT_CREATING', 'AWAITING_PAYMENT', 'CAPTURING', 'PAID'] as const;

export type Layer1Limits = {
  hardCapCents: number;
  maxUnitsPerLine: number;
  velocityMax: number;
  velocityWindowMinutes: number;
  splitSingleLimitCents: number;
  splitWindowMinutes: number;
  duplicateWindowMinutes: number;
  dailyHardCapCents: number;
  monthlyHardCapCents: number;
};

export const LAYER1_DEFAULTS: Layer1Limits = {
  hardCapCents: HARD_CAP_CENTS,
  maxUnitsPerLine: MAX_UNITS_PER_LINE,
  velocityMax: 3,
  velocityWindowMinutes: 30,
  splitSingleLimitCents: HARD_CAP_CENTS,
  splitWindowMinutes: 60,
  duplicateWindowMinutes: 10,
  dailyHardCapCents: 10 * HARD_CAP_CENTS,
  monthlyHardCapCents: 40 * HARD_CAP_CENTS,
};

// Windows are capped at a day so the history the server loads stays bounded (see MAX_WINDOW_MINUTES).
export const MAX_WINDOW_MINUTES = 1440;

const positiveInt = (raw: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

// Empty or invalid values fall back to the defaults. The split limit cannot exceed the hard cap (a single payment
// above it is already denied), and the monthly cap is never below the daily cap.
export function layer1Limits(env: NodeJS.ProcessEnv = process.env): Layer1Limits {
  const d = LAYER1_DEFAULTS;
  const dailyHardCapCents = positiveInt(env.LAYER1_DAILY_HARD_CAP_CENTS, d.dailyHardCapCents);
  return {
    hardCapCents: HARD_CAP_CENTS,
    maxUnitsPerLine: MAX_UNITS_PER_LINE,
    velocityMax: positiveInt(env.LAYER1_VELOCITY_MAX, d.velocityMax),
    velocityWindowMinutes: positiveInt(env.LAYER1_VELOCITY_WINDOW_MINUTES, d.velocityWindowMinutes, MAX_WINDOW_MINUTES),
    splitSingleLimitCents: positiveInt(env.LAYER1_SPLIT_SINGLE_LIMIT_CENTS, d.splitSingleLimitCents, HARD_CAP_CENTS),
    splitWindowMinutes: positiveInt(env.LAYER1_SPLIT_WINDOW_MINUTES, d.splitWindowMinutes, MAX_WINDOW_MINUTES),
    duplicateWindowMinutes: positiveInt(env.LAYER1_DUPLICATE_WINDOW_MINUTES, d.duplicateWindowMinutes, MAX_WINDOW_MINUTES),
    dailyHardCapCents,
    monthlyHardCapCents: Math.max(positiveInt(env.LAYER1_MONTHLY_HARD_CAP_CENTS, d.monthlyHardCapCents), dailyHardCapCents),
  };
}

// UTC calendar boundaries for the daily and monthly caps.
export const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const startOfUtcMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
