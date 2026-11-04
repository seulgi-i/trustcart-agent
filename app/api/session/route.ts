import { db } from '@/lib/db';
import { checkOrigin } from '@/lib/http';
import { createSession, findSession, sessionCookie } from '@/src/server/session';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (!checkOrigin(request)) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
  try {
    if (await findSession(db, request)) return Response.json({ active: true });
    const session = await createSession(db);
    return Response.json({ active: true }, { status: 201, headers: { 'Set-Cookie': sessionCookie(session.id) } });
  } catch {
    return Response.json({ error: 'Could not start a demo session. Check the database setup.' }, { status: 500 });
  }
}
