import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { layer1Limits } from '@/src/domain/layer1';
import { COOLDOWN_HOURS, DEFAULT_TIMEZONE, PRECHARGE_DELAY, RECOMMENDED } from '@/src/domain/spending-policy';
import { getPolicy, setPolicy } from '@/src/server/orders';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';

// Layer-1 system limits (read-only) and the bounds/recommendations the /policy form shows for each Layer-2 field.
function limits() {
  const l1 = layer1Limits();
  return {
    layer1: l1,
    bounds: {
      perOrderMaxCents: { min: 1, max: l1.hardCapCents },
      dailyMaxCents: { min: 1, max: l1.dailyHardCapCents },
      categoryMaxCents: { min: 1, max: l1.hardCapCents },
      requireApprovalAboveCents: { min: 0, max: l1.hardCapCents },
      prechargeDelaySeconds: { min: PRECHARGE_DELAY.min, max: PRECHARGE_DELAY.max },
      startHour: { min: 0, max: 23 },
      endHour: { min: 1, max: 24 },
    },
    recommended: RECOMMENDED,
    defaultTimezone: DEFAULT_TIMEZONE,
    cooldownHours: COOLDOWN_HOURS,
  };
}

export async function GET(request: Request) {
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    return Response.json({ ...(await getPolicy(db, session.id)), limits: limits() });
  } catch {
    return Response.json({ error: 'Could not load the spending policy.' }, { status: 500 });
  }
}

// Only the user's browser edits the policy, for its own session. The agent has no tool for it.
export async function PUT(request: Request) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await setPolicy(db, session.id, await request.json().catch(() => null));
    return Response.json(result.body, { status: result.status });
  } catch {
    return Response.json({ error: 'Could not save the spending policy.' }, { status: 500 });
  }
}
