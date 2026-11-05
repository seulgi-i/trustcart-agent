'use client';
import { useEffect, useState } from 'react';
import type { SpendingPolicy } from '@/src/domain/spending-policy';
import type { Layer1Limits } from '@/src/domain/layer1';

type Range = { min: number; max: number };
type Pending = { policy: SpendingPolicy; effectiveAt: string; loosenedFields: string[] };
type Loaded = {
  policy: SpendingPolicy; pending: Pending | null; isDefault: boolean; categories: string[];
  limits: {
    layer1: Layer1Limits; cooldownHours: number; defaultTimezone: string;
    bounds: Record<'perOrderMaxCents' | 'dailyMaxCents' | 'categoryMaxCents' | 'requireApprovalAboveCents' | 'prechargeDelaySeconds' | 'startHour' | 'endHour', Range>;
    recommended: { perOrderMaxCents: number; dailyMaxCents: number; requireApprovalAboveCents: number; allowedHours: { startHour: number; endHour: number }; prechargeDelaySeconds: number };
  };
};
type Form = {
  perOrderMaxUSD: string; dailyMaxUSD: string; requireApprovalAboveUSD: string; prechargeDelaySeconds: string;
  allowedCategories: string[]; categoryMaxUSD: Record<string, string>;
  startHour: string; endHour: string; allowedWeekdays: number[]; timezone: string;
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const dollars = (cents: number) => (cents / 100).toFixed(2);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FIELD_LABEL: Record<string, string> = {
  perOrderMaxCents: 'per-order maximum', dailyMaxCents: 'daily maximum', allowedCategories: 'allowed categories',
  perCategoryMaxCents: 'category limits', requireApprovalAboveCents: 'review threshold', allowedHours: 'allowed hours',
  allowedWeekdays: 'allowed weekdays', timezone: 'time zone', prechargeDelaySeconds: 'pre-charge delay',
};
const hoursText = (h: { startHour: number; endHour: number }) => h.startHour === h.endHour ? 'no hours' : `${h.startHour}:00–${h.endHour}:00`;

const toForm = (p: SpendingPolicy): Form => ({
  perOrderMaxUSD: dollars(p.perOrderMaxCents), dailyMaxUSD: dollars(p.dailyMaxCents),
  requireApprovalAboveUSD: dollars(p.requireApprovalAboveCents), prechargeDelaySeconds: String(p.prechargeDelaySeconds),
  allowedCategories: p.allowedCategories,
  categoryMaxUSD: Object.fromEntries(Object.entries(p.perCategoryMaxCents).map(([c, v]) => [c, dollars(v)])),
  startHour: String(p.allowedHours.startHour), endHour: String(p.allowedHours.endHour),
  allowedWeekdays: p.allowedWeekdays, timezone: p.timezone,
});
// The server validates again (integer cents, Layer-1 bounds, known categories, IANA zone); this is only for the form.
const toCents = (usdText: string) => Math.round(Number(usdText) * 100);

export function PolicyForm() {
  const [data, setData] = useState<Loaded | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [message, setMessage] = useState('');

  const load = () => fetch('/api/policy').then(r => r.json()).then((d: Loaded) => { setData(d); setForm(toForm(d.pending?.policy ?? d.policy)); });
  useEffect(() => { load().catch(() => setMessage('Could not load the spending policy.')); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const perCategoryMaxCents = Object.fromEntries(
      Object.entries(form.categoryMaxUSD).filter(([c, v]) => v.trim() && form.allowedCategories.includes(c)).map(([c, v]) => [c, toCents(v)]),
    );
    const res = await fetch('/api/policy', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        perOrderMaxCents: toCents(form.perOrderMaxUSD), dailyMaxCents: toCents(form.dailyMaxUSD),
        requireApprovalAboveCents: toCents(form.requireApprovalAboveUSD), prechargeDelaySeconds: Number(form.prechargeDelaySeconds),
        allowedCategories: form.allowedCategories, perCategoryMaxCents,
        allowedHours: { startHour: Number(form.startHour), endHour: Number(form.endHour) },
        allowedWeekdays: [...form.allowedWeekdays].sort(), timezone: form.timezone.trim(),
      }),
    });
    const body = await res.json().catch(() => ({})) as { error?: string; issues?: string[]; outcome?: string; tightenedFields?: string[]; loosenedFields?: string[]; pending?: Pending | null };
    if (!res.ok) { setMessage([body.error ?? 'Could not save.', ...(body.issues ?? [])].join(' ')); return; }
    const names = (f?: string[]) => (f ?? []).map(x => FIELD_LABEL[x] ?? x).join(', ');
    setMessage([
      body.tightenedFields?.length ? `Applied now: ${names(body.tightenedFields)}.` : body.outcome === 'APPLIED' ? 'Saved.' : '',
      body.pending ? `Loosened (${names(body.loosenedFields)}) takes effect ${new Date(body.pending.effectiveAt).toLocaleString()}.` : '',
    ].filter(Boolean).join(' '));
    await load();
  }

  if (!data || !form) return <p className="mt-4 text-sm">{message || 'Loading…'}</p>;
  const { policy, pending, limits } = data;
  const { layer1: l1, bounds, recommended } = limits;
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const toggleCategory = (c: string) => set({ allowedCategories: form.allowedCategories.includes(c) ? form.allowedCategories.filter(x => x !== c) : [...form.allowedCategories, c] });
  const toggleDay = (d: number) => set({ allowedWeekdays: form.allowedWeekdays.includes(d) ? form.allowedWeekdays.filter(x => x !== d) : [...form.allowedWeekdays, d] });
  const field = (label: string, key: 'perOrderMaxUSD' | 'dailyMaxUSD' | 'requireApprovalAboveUSD' | 'prechargeDelaySeconds', hint: string) => (
    <label className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      <input className="w-40 border px-2 py-1" inputMode="decimal" value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
      <span className="text-xs text-stone-500">{hint}</span>
    </label>
  );
  const hourSelect = (key: 'startHour' | 'endHour', range: Range) => (
    <select className="border px-1 py-1" value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}>
      {Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i).map(h => <option key={h} value={h}>{h}:00</option>)}
    </select>
  );

  return (
    <div className="mt-6 space-y-4 text-sm">
      <section className="rounded border border-stone-300 bg-stone-50 p-4">
        <h2 className="font-semibold">Layer 1 · System limits (fixed)</h2>
        <p className="text-stone-600">Set by the server. You cannot turn these off or raise them here, and the agent cannot either.</p>
        <ul className="mt-2 list-disc pl-5 text-stone-700">
          <li>Prompt-injection scan of seller text → review.</li>
          <li>Cart must match your purchase intent (budget, quantity, category) → review.</li>
          <li>Prices are finalized on the server; at most {usd(l1.hardCapCents)} per payment and {l1.maxUnitsPerLine} units per line.</li>
          <li>Velocity: at most {l1.velocityMax} payments per {l1.velocityWindowMinutes} minutes.</li>
          <li>Split-payment detection: payments for the same product or seller within {l1.splitWindowMinutes} minutes may not add up to more than {usd(l1.splitSingleLimitCents)}.</li>
          <li>Duplicate payment: the same cart and amount within {l1.duplicateWindowMinutes} minutes is blocked.</li>
          <li>Hard caps: {usd(l1.dailyHardCapCents)} per UTC day and {usd(l1.monthlyHardCapCents)} per UTC month.</li>
        </ul>
      </section>

      <form onSubmit={save} className="space-y-4 rounded border border-stone-300 bg-white p-4">
        <h2 className="font-semibold">Layer 2 · Your settings</h2>
        <p className="text-stone-600">
          In effect: per order ≤ {usd(policy.perOrderMaxCents)} · daily ≤ {usd(policy.dailyMaxCents)} · review above {usd(policy.requireApprovalAboveCents)}
          {' '}· {policy.allowedCategories.join(', ') || 'no categories'} · {hoursText(policy.allowedHours)} on {policy.allowedWeekdays.map(d => WEEKDAYS[d]).join(' ') || 'no days'} ({policy.timezone})
          {' '}· pre-charge {policy.prechargeDelaySeconds}s{data.isDefault && ' (defaults)'}
        </p>
        <p className="rounded border border-sky-200 bg-sky-50 p-2 text-stone-700">
          Tightening (lower caps, fewer categories/days/hours, a longer pre-charge delay) applies immediately. Loosening waits {limits.cooldownHours} hours.
          If one save does both, the tightened parts apply now and the loosened parts wait. Saving again replaces a pending change and restarts its clock.
        </p>
        {pending && (
          <p role="status" className="rounded border border-amber-400 bg-amber-50 p-2">
            Pending loosening ({pending.loosenedFields.map(f => FIELD_LABEL[f] ?? f).join(', ')}) takes effect {new Date(pending.effectiveAt).toLocaleString()}. The form below shows the requested values.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {field('Per-order maximum (USD)', 'perOrderMaxUSD', `Denied above this. Range ${usd(bounds.perOrderMaxCents.min)}–${usd(bounds.perOrderMaxCents.max)}; recommended ${usd(recommended.perOrderMaxCents)}.`)}
          {field('Daily maximum (USD)', 'dailyMaxUSD', `Payments in progress or paid today (UTC) plus this cart. Up to ${usd(bounds.dailyMaxCents.max)}; recommended ${usd(recommended.dailyMaxCents)}.`)}
          {field('Always review above (USD)', 'requireApprovalAboveUSD', `Above this a cart always goes to the review inbox. 0 = review every order. Up to ${usd(bounds.requireApprovalAboveCents.max)}; recommended ${usd(recommended.requireApprovalAboveCents)}.`)}
          {field('Pre-charge delay (seconds)', 'prechargeDelaySeconds', `Countdown before capture, with Cancel. ${bounds.prechargeDelaySeconds.min}–${bounds.prechargeDelaySeconds.max}; default ${recommended.prechargeDelaySeconds}.`)}
        </div>

        <fieldset>
          <legend className="font-medium">Allowed categories and optional category limits (USD)</legend>
          <div className="mt-1 space-y-1">
            {data.categories.map(c => (
              <div key={c} className="flex items-center gap-3">
                <label className="flex w-32 items-center gap-1"><input type="checkbox" checked={form.allowedCategories.includes(c)} onChange={() => toggleCategory(c)} />{c}</label>
                <input className="w-28 border px-2 py-0.5" inputMode="decimal" placeholder="no limit" disabled={!form.allowedCategories.includes(c)}
                  value={form.categoryMaxUSD[c] ?? ''} onChange={e => set({ categoryMaxUSD: { ...form.categoryMaxUSD, [c]: e.target.value } })} />
              </div>
            ))}
          </div>
          <span className="text-xs text-stone-500">At least one category. Other categories go to the review inbox. A category limit is denied above, and cannot exceed the per-order maximum.</span>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="font-medium">When payments are allowed</legend>
          <div className="flex flex-wrap items-center gap-2">
            From {hourSelect('startHour', bounds.startHour)} to {hourSelect('endHour', bounds.endHour)}
            <span className="text-xs text-stone-500">End is exclusive. Start after end is overnight (22–6). 0–24 = all day. Recommended {hoursText(recommended.allowedHours)}.</span>
          </div>
          <div className="flex flex-wrap gap-3">
            {WEEKDAYS.map((d, i) => <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={form.allowedWeekdays.includes(i)} onChange={() => toggleDay(i)} />{d}</label>)}
          </div>
          <label className="flex items-center gap-2">
            Time zone <input className="w-56 border px-2 py-0.5" value={form.timezone} onChange={e => set({ timezone: e.target.value })} />
            <span className="text-xs text-stone-500">IANA name, e.g. America/New_York or Asia/Seoul (default {limits.defaultTimezone}).</span>
          </label>
          <span className="block text-xs text-stone-500">Outside these hours or days, a payment is denied.</span>
        </fieldset>

        <div className="flex items-center gap-3">
          <button className="rounded bg-stone-800 px-3 py-1 text-white">Save</button>
          <span className="text-stone-700">{message}</span>
        </div>
      </form>
    </div>
  );
}
