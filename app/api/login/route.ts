import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { checkPassword, gateCookie, gateEnabled, issueGateToken } from '@/src/server/demo-gate';
import { clientKey, consumeLoginAttempt } from '@/src/server/rate-limit';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  if (!gateEnabled()) return Response.json({ ok: true });
  let password: unknown;
  try { password = ((await request.json()) as { password?: unknown }).password; }
  catch { return Response.json({ error: 'Please enter the demo password.' }, { status: 400 }); }
  try {
    if (!(await consumeLoginAttempt(db, clientKey(request)))) return Response.json({ error: 'Too many attempts. Try again in 15 minutes.' }, { status: 429 });
  } catch {
    return Response.json({ error: 'Sign-in is unavailable right now. Please try again shortly.' }, { status: 503 });
  }
  if (!checkPassword(password)) return Response.json({ error: 'Incorrect password.' }, { status: 401 });
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': gateCookie(issueGateToken()) } });
}
