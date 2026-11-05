import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Optional password gate for a public demo deployment. Disabled when DEMO_PASSWORD is unset.
export const GATE_COOKIE = 'tc_gate';
const GATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN = /^(\d{1,13})\.([A-Za-z0-9_-]{43})$/;

export const gateEnabled = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.DEMO_PASSWORD);

// SESSION_SECRET if set, else derived from the password. Both feed the key, so changing either one signs everybody out.
function signingKey(env: NodeJS.ProcessEnv) {
  return createHash('sha256').update(`trustcart-demo-gate\0${env.SESSION_SECRET ?? ''}\0${env.DEMO_PASSWORD ?? ''}`).digest();
}
const sign = (expiresAt: number, env: NodeJS.ProcessEnv) => createHmac('sha256', signingKey(env)).update(`gate.v1.${expiresAt}`).digest('base64url');

// Hashing both sides first makes the comparison constant-time regardless of the input length.
export function checkPassword(input: unknown, env: NodeJS.ProcessEnv = process.env) {
  const password = env.DEMO_PASSWORD;
  if (!password || typeof input !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(input), digest(password));
}

export function issueGateToken(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + GATE_TTL_SECONDS;
  return `${expiresAt}.${sign(expiresAt, env)}`;
}

export function verifyGateToken(token: string | undefined, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  if (!gateEnabled(env)) return false;
  const match = token ? TOKEN.exec(token) : null;
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt * 1000 <= now) return false;
  return timingSafeEqual(Buffer.from(match[2]), Buffer.from(sign(expiresAt, env)));
}

export function gateCookie(token: string, secure = process.env.NODE_ENV === 'production') {
  return `${GATE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GATE_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

// The login page and its API stay reachable; static assets are excluded by the proxy matcher.
export const isPublicPath = (pathname: string) => pathname === '/login' || pathname === '/api/login';

// Only same-site absolute paths, so ?next= cannot become an open redirect.
export function safeNextPath(next: string | null | undefined) {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
}
