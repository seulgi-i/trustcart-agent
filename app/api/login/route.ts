import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { checkPassword, gateCookie, gateEnabled, issueGateToken } from '@/src/server/demo-gate';
import { clientKey, consumeLoginAttempt } from '@/src/server/rate-limit';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!checkOrigin(request)) return Response.json({ error: '허용되지 않은 출처입니다.' }, { status: 403 });
  if (!gateEnabled()) return Response.json({ ok: true });
  let password: unknown;
  try { password = ((await request.json()) as { password?: unknown }).password; }
  catch { return Response.json({ error: '비밀번호를 입력해 주세요.' }, { status: 400 }); }
  try {
    if (!(await consumeLoginAttempt(db, clientKey(request)))) return Response.json({ error: '시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요.' }, { status: 429 });
  } catch {
    return Response.json({ error: '지금은 로그인할 수 없어요. 잠시 후 다시 시도해 주세요.' }, { status: 503 });
  }
  if (!checkPassword(password)) return Response.json({ error: '비밀번호가 올바르지 않습니다.' }, { status: 401 });
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': gateCookie(issueGateToken()) } });
}
