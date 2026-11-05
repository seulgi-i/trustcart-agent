import { createHash } from 'node:crypto';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The slice of PrismaClient the limiter needs, so tests can pass an in-memory fake.
export type RateLimitStore = {
  rateLimit: {
    upsert(args: {
      where: { key_windowStart: { key: string; windowStart: Date } };
      create: { key: string; windowStart: Date; count: number };
      update: { count: { increment: number } };
      select: { count: true };
    }): PromiseLike<{ count: number }>;
  };
};

export type ChatQuota = { ok: true } | { ok: false; scope: 'session' | 'ip'; retryAfterSeconds: number };

function positiveInt(value: string | undefined, fallback: number) {
  const n = Number(value?.trim());
  return value?.trim() && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function chatLimits(env: NodeJS.ProcessEnv = process.env) {
  return {
    session: { limit: positiveInt(env.RATE_LIMIT_SESSION_PER_HOUR, 10), windowMs: HOUR_MS },
    ip: { limit: positiveInt(env.RATE_LIMIT_GLOBAL_PER_DAY, 30), windowMs: DAY_MS },
  };
}

// Client-supplied hops are spoofable, so trust what the platform sets: x-vercel-forwarded-for, then X-Real-IP, then
// the rightmost X-Forwarded-For entry (appended by the nearest proxy). Requests without any share one bucket, which
// then acts as a global cap. Only a hash is stored.
export function clientKey(request: Request) {
  const last = (header: string) => request.headers.get(header)?.split(',').map(s => s.trim()).filter(Boolean).at(-1);
  const ip = last('x-vercel-forwarded-for') || request.headers.get('x-real-ip')?.trim() || last('x-forwarded-for') || 'unknown';
  return createHash('sha256').update(ip).digest('base64url').slice(0, 22);
}

// Fixed windows aligned to the epoch. The upsert is a single INSERT ... ON CONFLICT DO UPDATE on Postgres, so
// concurrent requests cannot both read the same count. A losing insert race (P2002) is retried once as an update.
async function hit(db: RateLimitStore, key: string, windowMs: number, now: Date) {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const args = { where: { key_windowStart: { key, windowStart } }, create: { key, windowStart, count: 1 }, update: { count: { increment: 1 } }, select: { count: true as const } };
  let row;
  try { row = await db.rateLimit.upsert(args); }
  catch (error) {
    if ((error as { code?: string })?.code !== 'P2002') throw error;
    row = await db.rateLimit.upsert(args);
  }
  return { count: row.count, retryAfterSeconds: Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000) };
}

// Every call counts, including refused ones. The per-IP bucket is only charged once the session bucket allows it.
export async function consumeChatQuota(db: RateLimitStore, sessionId: string, ipKey: string, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<ChatQuota> {
  const limits = chatLimits(env);
  const session = await hit(db, `chat:session:${sessionId}`, limits.session.windowMs, now);
  if (session.count > limits.session.limit) return { ok: false, scope: 'session', retryAfterSeconds: session.retryAfterSeconds };
  const ip = await hit(db, `chat:ip:${ipKey}`, limits.ip.windowMs, now);
  if (ip.count > limits.ip.limit) return { ok: false, scope: 'ip', retryAfterSeconds: ip.retryAfterSeconds };
  return { ok: true };
}

// Slows password guessing on the demo gate: 10 attempts per IP per 15 minutes.
export async function consumeLoginAttempt(db: RateLimitStore, ipKey: string, now = new Date()) {
  const attempt = await hit(db, `login:ip:${ipKey}`, 15 * 60 * 1000, now);
  return attempt.count <= 10;
}

export function rateLimitMessage(quota: Extract<ChatQuota, { ok: false }>) {
  return quota.scope === 'session'
    ? 'Too many requests. This session has used its hourly AI chat limit. Please try again later. Approvals and payments still work.'
    : "Today's AI chat limit has been reached. Please try again tomorrow. Approvals and payments still work.";
}
