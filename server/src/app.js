import express from 'express';
import crypto from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { z } from 'zod';
import { env } from './config/env.js';
import { logger } from './infrastructure/logging/logger.js';
import { prisma } from './infrastructure/database/prisma.js';
import { runChat } from './modules/chat/service.js';
import { errorHandler } from './middleware/errors.js';
import { authenticate, rateLimitRequest, verifyOrigin } from './middleware/security.js';
import { authRouter } from './modules/auth/routes.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN.split(',').map((x) => x.trim()), credentials: true }));
app.use(pinoHttp({ logger, genReqId: (req) => req.headers['x-request-id']?.toString().slice(0, 100) || crypto.randomUUID(), redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.message', 'req.body.password', 'req.body.email'] }));
app.use('/api', verifyOrigin, rateLimitRequest);
app.use('/api', express.json({ limit: env.MAX_REQUEST_BYTES }));
app.use('/api/auth', authRouter);
app.use('/api', authenticate);

app.get('/api/auth/me', (req, res) => res.json({ success: true, data: { user: req.user }, error: null }));

app.get('/api/health', async (req, res) => {
  let database = 'not_configured';
  if (prisma) { try { await prisma.$queryRaw`SELECT 1`; database = 'ready'; } catch { database = 'unavailable'; } }
  res.status(database === 'unavailable' ? 503 : 200).json({ success: true, data: { application: 'ready', database, geminiConfigured: Boolean(env.GEMINI_API_KEY), groqConfigured: Boolean(env.GROQ_API_KEY), searchConfigured: Boolean(env.TAVILY_API_KEY) }, error: null });
});

app.post('/api/chat', async (req, res, next) => {
  const parsed = z.object({ conversationId: z.string().optional(), message: z.string().trim().min(1).max(12000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, data: null, error: { code: 'INVALID_REQUEST', message: 'Provide a message of 1 to 12000 characters.' } });
  if (!prisma) return next(Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' }));
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
  const send = (event) => { if (event.type === 'conversation') req.log.info({ conversationId: event.conversationId }, 'Conversation request started'); if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
  try { await runChat({ ...parsed.data, userId: req.user.id, onEvent: send }); }
  catch (error) { send({ type: 'error', code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? 'The request failed.' }); }
  finally { res.end(); }
});

app.get('/api/conversations', async (req, res, next) => {
  if (!prisma) return next(Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' }));
  try {
    const take = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const items = await prisma.conversation.findMany({ where: { userId: req.user.id }, orderBy: { updatedAt: 'desc' }, take, ...(req.query.cursor ? { skip: 1, cursor: { id: String(req.query.cursor) } } : {}) });
    res.json({ success: true, data: { items, nextCursor: items.length === take ? items.at(-1).id : null }, error: null });
  } catch (error) { next(error); }
});
app.get('/api/conversations/:id', async (req, res, next) => {
  if (!prisma) return next(Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' }));
  try { const data = await prisma.conversation.findFirst({ where: { id: req.params.id, userId: req.user.id }, include: { messages: { orderBy: { createdAt: 'asc' }, include: { sources: true } } } }); if (!data) return res.status(404).json({ success: false, data: null, error: { code: 'NOT_FOUND', message: 'Conversation was not found.' } }); res.json({ success: true, data, error: null }); } catch (error) { next(error); }
});
app.patch('/api/conversations/:id', async (req, res, next) => {
  const parsed = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, data: null, error: { code: 'INVALID_REQUEST', message: 'Provide a title under 120 characters.' } });
  if (!prisma) return next(Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' }));
  try { const result = await prisma.conversation.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: parsed.data }); if (!result.count) return res.status(404).json({ success: false, data: null, error: { code: 'NOT_FOUND', message: 'Conversation was not found.' } }); const data = await prisma.conversation.findUnique({ where: { id: req.params.id } }); res.json({ success: true, data, error: null }); } catch (error) { next(error); }
});
app.delete('/api/conversations/:id', async (req, res, next) => {
  if (!prisma) return next(Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' }));
  try { const result = await prisma.conversation.deleteMany({ where: { id: req.params.id, userId: req.user.id } }); if (!result.count) return res.status(404).json({ success: false, data: null, error: { code: 'NOT_FOUND', message: 'Conversation was not found.' } }); res.json({ success: true, data: { deleted: true }, error: null }); } catch (error) { next(error); }
});
app.use(errorHandler);
