import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma.js';
import { env } from '../../config/env.js';
import { parseCookies } from '../../middleware/security.js';
import { createSession, hashPassword, hashSession, normalizeEmail, sessionCookieOptions, clearSessionCookieOptions, verifyPassword } from './service.js';

export const authRouter = Router();
const credentialsSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(10).max(128) });
const failure = (res, status, code, message) => res.status(status).json({ success: false, data: null, error: { code, message } });
const dummyPasswordHash = hashPassword('nonexistent-account-password');

function databaseReady(res) {
  if (prisma) return true;
  failure(res, 503, 'DATABASE_UNAVAILABLE', 'Account service is not configured.');
  return false;
}

async function issueSession(user, res) {
  const session = await createSession(user.id);
  res.cookie(env.SESSION_COOKIE_NAME, session.token, sessionCookieOptions());
  res.json({ success: true, data: { user: { id: user.id, email: user.email } }, error: null });
}

authRouter.post('/signup', async (req, res, next) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return failure(res, 400, 'INVALID_CREDENTIALS', 'Use a valid email and a password with at least 10 characters.');
  if (!databaseReady(res)) return;
  try {
    const email = normalizeEmail(parsed.data.email);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = await prisma.user.create({ data: { email, passwordHash }, select: { id: true, email: true } });
    await issueSession(user, res);
  } catch (error) {
    if (error.code === 'P2002') return failure(res, 409, 'ACCOUNT_EXISTS', 'An account with that email already exists.');
    next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return failure(res, 400, 'INVALID_CREDENTIALS', 'Enter a valid email and password.');
  if (!databaseReady(res)) return;
  try {
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(parsed.data.email) } });
    const valid = await verifyPassword(parsed.data.password, user?.passwordHash ?? await dummyPasswordHash);
    if (!valid) return failure(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    await issueSession(user, res);
  } catch (error) { next(error); }
});

authRouter.post('/logout', async (req, res, next) => {
  if (!databaseReady(res)) return;
  try {
    const token = parseCookies(req.headers.cookie)[env.SESSION_COOKIE_NAME];
    if (token) await prisma.session.deleteMany({ where: { tokenHash: hashSession(token) } });
    res.clearCookie(env.SESSION_COOKIE_NAME, clearSessionCookieOptions());
    res.json({ success: true, data: { loggedOut: true }, error: null });
  } catch (error) { next(error); }
});
