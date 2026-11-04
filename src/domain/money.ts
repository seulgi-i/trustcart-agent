// USD amounts are integer cents everywhere in the domain. Decimal numbers are only an input/display format.

const USD_STRING = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

export function usdToCents(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('USD amount must be a non-negative finite number');
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 1e-6 || !Number.isSafeInteger(cents)) throw new RangeError('USD amount must have at most 2 decimal places');
  return cents;
}

export function isUsdAmount(value: number) {
  try { usdToCents(value); return true; } catch { return false; }
}

export function usdStringToCents(value: string): number {
  const match = USD_STRING.exec(value);
  if (!match) throw new RangeError('Invalid USD amount string');
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

export function centsToUsdString(cents: number): string {
  assertCents(cents);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function lineTotalCents(unitCents: number, quantity: number): number {
  assertCents(unitCents);
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError('Quantity must be a non-negative integer');
  const total = unitCents * quantity;
  assertCents(total);
  return total;
}

export const formatUsd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function assertCents(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Cents must be a non-negative safe integer');
}
