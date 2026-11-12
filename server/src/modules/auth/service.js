import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { prisma } from '../../infrastructure/database/prisma.js';
import { env } from '../../config/env.js';

const scrypt = promisify(crypto.scrypt);
const passwordCost = 32768;
const sessionMaxAgeMs = env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: passwordCost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, saltText, keyText] = encoded.split('$');
    if (algorithm !== 'scrypt' || !saltText || !keyText) return false;
    const expected = Buffer.from(keyText, 'base64url');
    const actual = await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, { N: passwordCost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

export function normalizeEmail(email) { return email.trim().toLowerCase(); }
export function hashSession(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSession(token);
  const expiresAt = new Date(Date.now() + sessionMaxAgeMs);
  await prisma.session.create({ data: { tokenHash, userId, expiresAt } });
  return { token, expiresAt };
}

export function sessionCookieOptions() {
  return { httpOnly: true, secure: env.NODE_ENV === 'production' || env.COOKIE_SAME_SITE === 'none', sameSite: env.COOKIE_SAME_SITE, path: '/api', maxAge: sessionMaxAgeMs };
}
export function clearSessionCookieOptions() {
  return { httpOnly: true, secure: env.NODE_ENV === 'production' || env.COOKIE_SAME_SITE === 'none', sameSite: env.COOKIE_SAME_SITE, path: '/api' };
}
