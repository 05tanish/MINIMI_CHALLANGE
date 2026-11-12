import { env } from '../config/env.js';
import { prisma } from '../infrastructure/database/prisma.js';
import { hashSession } from '../modules/auth/service.js';

const localWindows = new Map();
const lua = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); end; return {n,redis.call('PTTL',KEYS[1])}";
const origins = new Set(env.CLIENT_ORIGIN.split(',').map((x) => x.trim()).filter(Boolean));

export function verifyOrigin(req, res, next) {
  if (env.NODE_ENV === 'test' || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || !origins.has(origin)) return res.status(403).json(failure('CSRF_REJECTED', 'Request origin was not allowed.'));
  next();
}

export async function authenticate(req, res, next) {
  if (req.path === '/health') return next();
  if (env.NODE_ENV === 'test') { req.user = { id: 'test-user', email: 'test@example.invalid' }; return next(); }
  if (!prisma) return res.status(503).json(failure('AUTH_UNAVAILABLE', 'Authentication service is not configured.'));
  try {
    const token = parseCookies(req.headers.cookie)[env.SESSION_COOKIE_NAME];
    if (!token) return res.status(401).json(failure('UNAUTHORIZED', 'Please sign in to continue.'));
    const session = await prisma.session.findUnique({ where: { tokenHash: hashSession(token) }, include: { user: { select: { id: true, email: true } } } });
    if (!session || session.expiresAt <= new Date()) {
      if (session) await prisma.session.deleteMany({ where: { tokenHash: session.tokenHash } });
      return res.status(401).json(failure('UNAUTHORIZED', 'Your session expired. Please sign in again.'));
    }
    req.user = session.user;
    req.sessionTokenHash = session.tokenHash;
    next();
  } catch (error) { next(error); }
}

export async function rateLimitRequest(req, res, next) {
  const now = Date.now();
  const windowStart = Math.floor(now / env.RATE_LIMIT_WINDOW_MS) * env.RATE_LIMIT_WINDOW_MS;
  const key = `minimi:rate:${windowStart}:${req.ip}`;
  let count;
  if (env.REDIS_REST_URL && env.REDIS_REST_TOKEN) {
    try {
      const response = await fetch(`${env.REDIS_REST_URL.replace(/\/$/, '')}/`, {
        method: 'POST', headers: { authorization: `Bearer ${env.REDIS_REST_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(['EVAL', lua, '1', key, String(env.RATE_LIMIT_WINDOW_MS)]), signal: AbortSignal.timeout(1500)
      });
      if (!response.ok) throw new Error(`Redis REST returned ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error);
      count = Number(payload.result?.[0]);
      if (!Number.isFinite(count)) throw new Error('Redis REST returned an invalid counter');
    } catch (error) { req.log?.warn({ error: error.message }, 'Redis rate limiter unavailable; using local fallback'); }
  }
  if (count === undefined) {
    for (const [storedKey, value] of localWindows) if (value.expiresAt <= now) localWindows.delete(storedKey);
    const current = localWindows.get(key) ?? { count: 0, expiresAt: windowStart + env.RATE_LIMIT_WINDOW_MS };
    current.count += 1; localWindows.set(key, current); count = current.count;
  }
  if (count > env.RATE_LIMIT_MAX) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((windowStart + env.RATE_LIMIT_WINDOW_MS - now) / 1000))));
    return res.status(429).json(failure('RATE_LIMITED', 'Too many requests. Please retry shortly.'));
  }
  next();
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    if (index < 0) return [item, ''];
    try { return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))]; }
    catch { return [item.slice(0, index), item.slice(index + 1)]; }
  }));
}

function failure(code, message) { return { success: false, data: null, error: { code, message } }; }
