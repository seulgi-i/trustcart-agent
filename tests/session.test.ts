import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../lib/db';
import { runtimeCatalog } from '../src/server/catalog';
import { createSession, readSessionId, SESSION_COOKIE, sessionCookie } from '../src/server/session';
import { POST as requestApproval } from '../app/api/approvals/route';
import { PATCH as reviewApproval } from '../app/api/approvals/[id]/route';
import { POST as chat } from '../app/api/chat/route';

// Requires the throwaway DB prepared by scripts/test.ts (npm test).
before(async () => {
  for (const product of runtimeCatalog()) await db.product.upsert({ where: { id: product.id }, create: product, update: product });
});
after(() => db.$disconnect());

const cookie = (id: string) => `${SESSION_COOKIE}=${id}`;
const post = (sessionCookie?: string) => requestApproval(new Request('http://localhost/api/approvals', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(sessionCookie ? { cookie: sessionCookie } : {}) },
  body: JSON.stringify({ budget: 50, items: [{ productId: 'camp-06', quantity: 1 }] }),
}));
const patch = (id: string, sessionCookie: string, status: string) => reviewApproval(new Request(`http://localhost/api/approvals/${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', cookie: sessionCookie }, body: JSON.stringify({ status }),
}), { params: Promise.resolve({ id }) });

test('session cookie is server-issued, HttpOnly and strictly parsed', () => {
  const header = sessionCookie('a'.repeat(43), true);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Secure/);
  assert.equal(readSessionId(`x=1; ${SESSION_COOKIE}=${'a'.repeat(43)}`), 'a'.repeat(43));
  assert.equal(readSessionId(`${SESSION_COOKIE}=short`), null);
  assert.equal(readSessionId(null), null);
});

test('session_ownership', async () => {
  const [a, b] = [await createSession(db), await createSession(db)];
  assert.equal((await post()).status, 401);
  const created = await post(cookie(b.id));
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };

  for (const status of ['APPROVED', 'REJECTED']) assert.equal((await patch(id, cookie(a.id), status)).status, 404);
  assert.equal((await db.approval.findUniqueOrThrow({ where: { id } })).status, 'PENDING');

  assert.equal((await patch(id, cookie(b.id), 'APPROVED')).status, 200);
  assert.equal((await db.approval.findUniqueOrThrow({ where: { id } })).status, 'APPROVED');
});

test('expired sessions are rejected', async () => {
  const expired = await createSession(db, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  assert.equal((await post(cookie(expired.id))).status, 401);
});

test('chat requires a same-origin request with a valid session', async () => {
  const send = (headers: Record<string, string>) => chat(new Request('http://localhost/api/chat', { method: 'POST', headers, body: '{}' }));
  const session = await createSession(db);
  assert.equal((await send({ origin: 'https://evil.example', cookie: cookie(session.id) })).status, 403);
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ cookie: cookie('a'.repeat(43)) })).status, 401);
  // A valid session gets past the gate to input validation.
  assert.equal((await send({ cookie: cookie(session.id) })).status, 400);
});
