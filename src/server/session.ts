import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export const SESSION_COOKIE = 'tc_session';
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

export function newSessionId() {
  return randomBytes(32).toString('base64url');
}

export function readSessionId(cookieHeader: string | null): string | null {
  for (const part of cookieHeader?.split(';') ?? []) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const id = value.join('=');
      return SESSION_ID.test(id) ? id : null;
    }
  }
  return null;
}

export function sessionCookie(id: string, secure = process.env.NODE_ENV === 'production') {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

export function createSession(db: PrismaClient, now = new Date()) {
  return db.demoSession.create({ data: { id: newSessionId(), expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000) } });
}

export async function findSession(db: PrismaClient, request: Request, now = new Date()) {
  const id = readSessionId(request.headers.get('cookie'));
  if (!id) return null;
  const session = await db.demoSession.findUnique({ where: { id } });
  return session && session.expiresAt > now ? session : null;
}

// Every lookup or mutation of a session-owned row goes through this filter, so a foreign ID behaves like a missing one.
export const ownedBy = (sessionId: string, id: string) => ({ id, sessionId });
