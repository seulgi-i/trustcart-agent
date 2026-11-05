import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
import { AI_RESTING, friendlyAiError, redactKeys } from '../lib/ai-errors';
import { checkPassword, GATE_COOKIE, gateCookie, issueGateToken, safeNextPath, verifyGateToken } from '../src/server/demo-gate';
import { chatLimits, clientKey, consumeChatQuota, consumeLoginAttempt, type RateLimitStore } from '../src/server/rate-limit';
import { appOrigin, checkoutUrls } from '../src/server/payments/provider';
import { POST as login } from '../app/api/login/route';

// Next's types make NODE_ENV required on ProcessEnv, so partial test envs go through unknown.
const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv;
const gateEnv = env({ DEMO_PASSWORD: 'open sesame' });

// In-memory stand-in for prisma.rateLimit with the same upsert semantics.
function fakeStore(options: { raceOnce?: boolean } = {}) {
  const rows = new Map<string, number>();
  let race = options.raceOnce ?? false;
  const store: RateLimitStore = {
    rateLimit: {
      async upsert({ where: { key_windowStart: { key, windowStart } } }) {
        if (race) { race = false; throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }); }
        const id = `${key}@${windowStart.toISOString()}`;
        const count = (rows.get(id) ?? 0) + 1;
        rows.set(id, count);
        return { count };
      },
    },
  };
  return { store, rows };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('password check is exact and disabled without DEMO_PASSWORD', () => {
  assert.equal(checkPassword('open sesame', gateEnv), true);
  assert.equal(checkPassword('open sesame ', gateEnv), false);
  assert.equal(checkPassword('', gateEnv), false);
  assert.equal(checkPassword(42, gateEnv), false);
  assert.equal(checkPassword('anything', env()), false);
});

test('gate tokens are HMAC-signed, expire, and are bound to the password and SESSION_SECRET', () => {
  const now = Date.UTC(2026, 10, 5);
  const token = issueGateToken(gateEnv, now);
  assert.equal(verifyGateToken(token, gateEnv, now), true);
  assert.equal(verifyGateToken(token, gateEnv, now + 8 * 24 * 60 * 60 * 1000), false);
  const [exp, mac] = token.split('.');
  assert.equal(verifyGateToken(`${Number(exp) + 999999}.${mac}`, gateEnv, now), false);
  assert.equal(verifyGateToken(`${exp}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, gateEnv, now), false);
  assert.equal(verifyGateToken(token, env({ DEMO_PASSWORD: 'other' }), now), false);
  assert.equal(verifyGateToken(token, env({ DEMO_PASSWORD: 'open sesame', SESSION_SECRET: 's3cret' }), now), false);
  assert.equal(verifyGateToken(token, env(), now), false);
  assert.equal(verifyGateToken(undefined, gateEnv, now), false);
  assert.equal(verifyGateToken('garbage', gateEnv, now), false);
});

test('gate cookie is HttpOnly, SameSite=Lax, and Secure only when asked', () => {
  assert.match(gateCookie('t', true), /^tc_gate=t; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(gateCookie('t', false), /Secure/);
});

test('next= only allows same-site paths', () => {
  assert.equal(safeNextPath('/approvals?x=1'), '/approvals?x=1');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '', null, undefined]) assert.equal(safeNextPath(bad), '/');
});

test('proxy: no-op without DEMO_PASSWORD; otherwise gates pages and API, leaves /login open', async () => {
  await withEnv({ DEMO_PASSWORD: undefined, SESSION_SECRET: undefined }, () => {
    assert.equal(proxy(new NextRequest('http://localhost/api/chat')).headers.get('x-middleware-next'), '1');
  });
  await withEnv({ DEMO_PASSWORD: 'open sesame', SESSION_SECRET: undefined }, async () => {
    const api = proxy(new NextRequest('http://localhost/api/approvals'));
    assert.equal(api.status, 401);
    assert.match(((await api.json()) as { error: string }).error, /비밀번호/);
    const page = proxy(new NextRequest('http://localhost/approvals?tab=1'));
    assert.equal(page.status, 307);
    assert.equal(page.headers.get('location'), 'http://localhost/login?next=%2Fapprovals%3Ftab%3D1');
    for (const open of ['http://localhost/login', 'http://localhost/api/login']) assert.equal(proxy(new NextRequest(open)).headers.get('x-middleware-next'), '1');
    const authed = new NextRequest('http://localhost/api/chat', { headers: { cookie: `${GATE_COOKIE}=${issueGateToken()}` } });
    assert.equal(proxy(authed).headers.get('x-middleware-next'), '1');
    const forged = new NextRequest('http://localhost/', { headers: { cookie: `${GATE_COOKIE}=${issueGateToken(env({ DEMO_PASSWORD: 'guess' }))}` } });
    assert.equal(proxy(forged).status, 307);
  });
});

test('login API is a no-op when the gate is disabled and rejects foreign origins', async () => {
  await withEnv({ DEMO_PASSWORD: undefined }, async () => {
    const ok = await login(new Request('http://localhost/api/login', { method: 'POST', body: '{}' }));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('set-cookie'), null);
    assert.equal((await login(new Request('http://localhost/api/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }))).status, 403);
  });
});

test('chat rate limit: 10/hour per session, then 30/day per IP, env-configurable', async () => {
  const { store } = fakeStore();
  const now = new Date(Date.UTC(2026, 10, 5, 10, 15));
  for (let i = 0; i < 10; i++) assert.deepEqual(await consumeChatQuota(store, 's1', 'ip1', now, env()), { ok: true });
  assert.deepEqual(await consumeChatQuota(store, 's1', 'ip1', now, env()), { ok: false, scope: 'session', retryAfterSeconds: 45 * 60 });
  // Next hour: the session bucket resets.
  assert.deepEqual(await consumeChatQuota(store, 's1', 'ip1', new Date(now.getTime() + 60 * 60 * 1000), env()), { ok: true });
  // Other sessions from the same IP share the daily bucket (11 used so far, the refused call did not count).
  let result;
  for (let i = 0; i < 19; i++) result = await consumeChatQuota(store, `s-${i}`, 'ip1', now, env());
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(await consumeChatQuota(store, 's-x', 'ip1', now, env()), { ok: false, scope: 'ip', retryAfterSeconds: Math.ceil((24 * 60 - 10 * 60 - 15) * 60) });
  assert.deepEqual(await consumeChatQuota(store, 's-y', 'ip2', now, env()), { ok: true });

  const tightEnv = env({ RATE_LIMIT_SESSION_PER_HOUR: '2', RATE_LIMIT_GLOBAL_PER_DAY: '5' });
  assert.deepEqual(chatLimits(tightEnv), { session: { limit: 2, windowMs: 3_600_000 }, ip: { limit: 5, windowMs: 86_400_000 } });
  assert.deepEqual(chatLimits(env({ RATE_LIMIT_SESSION_PER_HOUR: 'abc', RATE_LIMIT_GLOBAL_PER_DAY: '-1' })), chatLimits(env()));
  const small = fakeStore().store;
  await consumeChatQuota(small, 'a', 'ip', now, tightEnv);
  await consumeChatQuota(small, 'a', 'ip', now, tightEnv);
  assert.equal((await consumeChatQuota(small, 'a', 'ip', now, tightEnv)).ok, false);
});

test('rate limit retries a lost insert race once, and login attempts are capped', async () => {
  const { store } = fakeStore({ raceOnce: true });
  assert.deepEqual(await consumeChatQuota(store, 's', 'ip', new Date(), env()), { ok: true });
  const logins = fakeStore().store;
  for (let i = 0; i < 10; i++) assert.equal(await consumeLoginAttempt(logins, 'ip'), true);
  assert.equal(await consumeLoginAttempt(logins, 'ip'), false);
});

test('client key prefers platform headers and ignores spoofable leftmost X-Forwarded-For hops', () => {
  const key = (headers: Record<string, string>) => clientKey(new Request('http://localhost/', { headers }));
  // A client-forged leftmost hop must not change the bucket; the proxy-appended rightmost one does.
  assert.equal(key({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }), key({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }));
  assert.equal(key({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }), key({ 'x-real-ip': '203.0.113.7' }));
  assert.notEqual(key({ 'x-forwarded-for': '203.0.113.7' }), key({ 'x-forwarded-for': '203.0.113.8' }));
  // Precedence: x-vercel-forwarded-for > x-real-ip > x-forwarded-for.
  const vercel = key({ 'x-vercel-forwarded-for': '198.51.100.1' });
  assert.equal(key({ 'x-vercel-forwarded-for': '198.51.100.1', 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.8' }), vercel);
  assert.equal(key({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.8' }), key({ 'x-real-ip': '203.0.113.7' }));
  assert.equal(key({ 'x-forwarded-for': ' , ' }), key({}));
  assert.doesNotMatch(key({ 'x-forwarded-for': '203.0.113.7' }), /203/);
});

test('model quota errors become the friendly Korean message; keys are redacted', () => {
  for (const m of ['429 Too Many Requests', 'RESOURCE_EXHAUSTED: quota exceeded', 'You exceeded your current quota']) assert.equal(friendlyAiError(new Error(m)), AI_RESTING);
  assert.match(AI_RESTING, /^AI가 잠시 쉬고 있어요\.\.\./);
  assert.match(friendlyAiError(new Error('503 UNAVAILABLE high demand')), /503/);
  assert.match(friendlyAiError(new Error('models/x is not found')), /404/);
  assert.equal(redactKeys('key=AIzaSyAbc-123 and sk-proj-xyz'), 'key=AIza*** and sk-***');
});

test('checkout URLs come from APP_BASE_URL, then VERCEL_URL, then localhost outside production', () => {
  assert.equal(appOrigin(env({ APP_BASE_URL: 'https://shop.example/ignored/path', VERCEL_URL: 'x.vercel.app' })), 'https://shop.example');
  assert.equal(appOrigin(env({ VERCEL_URL: 'trustcart-abc.vercel.app', NODE_ENV: 'production' })), 'https://trustcart-abc.vercel.app');
  assert.equal(appOrigin(env({ NODE_ENV: 'development' })), 'http://localhost:3000');
  assert.throws(() => appOrigin(env({ NODE_ENV: 'production' })), /APP_BASE_URL/);
  assert.throws(() => appOrigin(env({ APP_BASE_URL: 'javascript:alert(1)' })));
  assert.deepEqual(checkoutUrls('o 1', 'https://shop.example'), {
    returnUrl: 'https://shop.example/checkout/return?orderId=o%201',
    cancelUrl: 'https://shop.example/checkout/cancel?orderId=o%201',
  });
});
