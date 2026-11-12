import crypto from 'node:crypto';
import { env } from '../config/env.js';

const localWindows = new Map();
const lua = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); end; return {n,redis.call('PTTL',KEYS[1])}";

export function authenticate(req, res, next) {
  if (!env.AUTH_TOKEN) {
    if (env.NODE_ENV === 'production') return res.status(503).json(failure('AUTH_NOT_CONFIGURED', 'API authentication is not configured.'));
    return next();
  }
  const supplied = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  const expected = Buffer.from(env.AUTH_TOKEN);
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return res.status(401).set('WWW-Authenticate', 'Bearer').json(failure('UNAUTHORIZED', 'A valid bearer token is required.'));
  }
  next();
}

export async function rateLimitRequest(req, res, next) {
  const now = Date.now();
  const windowStart = Math.floor(now / env.RATE_LIMIT_WINDOW_MS) * env.RATE_LIMIT_WINDOW_MS;
  const key = `minimi:rate:${windowStart}:${req.ip}`;
  let count;
  if (env.REDIS_REST_URL && env.REDIS_REST_TOKEN) {
    try {
      const response = await fetch(`${env.REDIS_REST_URL.replace(/\/$/, '')}/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.REDIS_REST_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(['EVAL', lua, '1', key, String(env.RATE_LIMIT_WINDOW_MS)]),
        signal: AbortSignal.timeout(1500)
      });
      if (!response.ok) throw new Error(`Redis REST returned ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error);
      count = Number(payload.result?.[0]);
      if (!Number.isFinite(count)) throw new Error('Redis REST returned an invalid counter');
    } catch (error) {
      req.log?.warn({ error: error.message }, 'Redis rate limiter unavailable; using local fallback');
    }
  }
  if (count === undefined) {
    for (const [storedKey, value] of localWindows) if (value.expiresAt <= now) localWindows.delete(storedKey);
    const current = localWindows.get(key) ?? { count: 0, expiresAt: windowStart + env.RATE_LIMIT_WINDOW_MS };
    current.count += 1;
    localWindows.set(key, current);
    count = current.count;
  }
  if (count > env.RATE_LIMIT_MAX) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((windowStart + env.RATE_LIMIT_WINDOW_MS - now) / 1000))));
    return res.status(429).json(failure('RATE_LIMITED', 'Too many requests. Please retry shortly.'));
  }
  next();
}

function failure(code, message) { return { success: false, data: null, error: { code, message } }; }
