import { prisma } from '../infrastructure/database/prisma.js';
import { embedText } from '../infrastructure/llm/gemini.js';
import { makeTopicChunks } from '../modules/retrieval/chunking.js';
import { logger } from '../infrastructure/logging/logger.js';
import { observeJob } from '../infrastructure/metrics.js';
import { processChatTurn } from '../modules/chat/service.js';

let polling = false;
let timer;
const activeChatJobs = new Set();

async function claimOne() {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT e."id" FROM "OutboxEvent" e
      WHERE ((e."status" = 'pending' AND e."runAt" <= NOW())
        OR (e."status" = 'processing' AND e."lockedAt" < NOW() - INTERVAL '5 minutes'))
        AND NOT EXISTS (
          SELECT 1 FROM "OutboxEvent" active
          WHERE active."aggregateId" = e."aggregateId"
            AND active."status" = 'processing'
            AND active."lockedAt" >= NOW() - INTERVAL '5 minutes'
        )
      ORDER BY e."createdAt" ASC
      FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows.length) return null;
    return tx.outboxEvent.update({ where: { id: rows[0].id }, data: { status: 'processing', lockedAt: new Date(), attempts: { increment: 1 } } });
  });
}

async function indexConversation(conversationId, signal) {
  const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: 200 });
  if (!messages.length) return;
  const chronological = messages.reverse();
  const chunks = makeTopicChunks(chronological).map((chunk) => ({ ...chunk, id: `chunk_${conversationId}_${chunk.messageIds.join('_')}` }));
  const ids = chunks.map((chunk) => chunk.id);
  const existing = await prisma.memoryChunk.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const existingIds = new Set(existing.map((row) => row.id));
  const pending = chunks.filter((chunk) => !existingIds.has(chunk.id));
  const embedded = await mapWithConcurrency(pending, 2, async (chunk) => ({
    ...chunk,
    embedding: await embedText(chunk.content, signal).catch((error) => {
      logger.warn({ code: error.code ?? error.name }, 'Index job embedding failed; retaining keyword index');
      return null;
    })
  }));
  await prisma.$transaction(async (tx) => {
    const stale = await tx.memoryChunk.findMany({ where: { conversationId, id: { notIn: ids } }, select: { id: true } });
    if (stale.length) {
      const staleIds = stale.map((row) => row.id);
      await tx.entityMention.deleteMany({ where: { conversationId, messageId: { in: chronological.map((message) => message.id) } } });
      await tx.memoryChunk.deleteMany({ where: { id: { in: staleIds } } });
    }
    for (const chunk of [...chunks.filter((item) => existingIds.has(item.id)), ...embedded]) {
      await tx.$executeRaw`INSERT INTO "MemoryChunk" (id, "conversationId", content, topic, entities, metadata, "startAt", "endAt", embedding, "searchVector") VALUES (${chunk.id}, ${conversationId}, ${chunk.content}, ${chunk.topic}, ${JSON.stringify(chunk.entities)}::jsonb, ${JSON.stringify({ messageIds: chunk.messageIds })}::jsonb, ${chunk.startAt}, ${chunk.endAt}, ${chunk.embedding ? `[${chunk.embedding.join(',')}]` : null}::vector, to_tsvector('english', ${chunk.content})) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, entities = EXCLUDED.entities, metadata = EXCLUDED.metadata, embedding = COALESCE(EXCLUDED.embedding, "MemoryChunk".embedding), "searchVector" = EXCLUDED."searchVector"`;
      for (const messageId of chunk.messageIds) for (const entity of chunk.entities) {
        const normalizedName = entity.name.toLowerCase();
        const entityRow = await tx.entity.upsert({ where: { normalizedName }, create: { name: entity.name, normalizedName, type: entity.type }, update: {} });
        await tx.entityMention.upsert({ where: { entityId_messageId: { entityId: entityRow.id, messageId } }, create: { entityId: entityRow.id, messageId, conversationId }, update: {} });
      }
    }
    // Extractive rolling summary keeps long histories retrievable without an
    // additional paid model call. It is deliberately labeled as conversation text.
    const summary = chronological.slice(-24).map((message) => `${message.role}: ${message.content.replace(/\s+/g, ' ').trim()}`).join('\n').slice(-12000);
    await tx.conversationSummary.upsert({ where: { conversationId }, create: { conversationId, summary }, update: { summary } });
  }, { timeout: 30000, maxWait: 10000 });
}

async function processOne() {
  if (activeChatJobs.size >= 3) return false;
  const event = await claimOne();
  if (!event) return false;
  try {
    if (event.type === 'memory.index') {
      const timeout = AbortSignal.timeout(20000);
      await indexConversation(event.aggregateId, timeout);
    } else if (event.type === 'chat.run') {
      const task = processChatEvent(event).finally(() => activeChatJobs.delete(task));
      activeChatJobs.add(task);
      return true;
    } else {
      throw new Error(`Unknown outbox event type: ${event.type}`);
    }
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'completed', lockedAt: null, lastError: null } });
    observeJob('completed');
    logger.info({ eventId: event.id, eventType: event.type, attempt: event.attempts }, 'Outbox event completed');
  } catch (error) {
    const terminal = event.attempts >= 5;
    const delayMs = Math.min(300000, 1000 * 2 ** event.attempts);
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: terminal ? 'failed' : 'pending', lockedAt: null, runAt: new Date(Date.now() + delayMs), lastError: (error.message ?? 'Indexing failed').slice(0, 2000) } });
    if (terminal) observeJob('failed');
    logger.error({ eventId: event.id, eventType: event.type, attempt: event.attempts, terminal, code: error.code ?? error.name }, 'Outbox event failed');
  }
  return true;
}

async function processChatEvent(event) {
  const turnId = event.payload.turnId;
  const heartbeat = setInterval(() => {
    void prisma.outboxEvent.updateMany({ where: { id: event.id, status: 'processing' }, data: { lockedAt: new Date() } })
      .catch((error) => logger.warn({ eventId: event.id, code: error.code ?? error.name }, 'Chat job lease refresh failed'));
  }, 60000);
  heartbeat.unref();
  let sequence = 0;
  let pendingWrites = Promise.resolve();
  const emit = (payload) => {
    const currentSequence = ++sequence;
    pendingWrites = pendingWrites.then(() => prisma.chatTurnEvent.create({ data: { turnId, sequence: currentSequence, type: payload.type, payload } }));
    return pendingWrites;
  };
  emit.flush = () => pendingWrites;
  try {
    const latest = await prisma.chatTurnEvent.aggregate({ where: { turnId }, _max: { sequence: true } });
    sequence = latest._max.sequence ?? 0;
    await processChatTurn({ turnId, onEvent: emit });
    await emit.flush();
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'completed', lockedAt: null, lastError: null } });
    observeJob('completed');
    logger.info({ eventId: event.id, turnId, attempt: event.attempts }, 'Chat job completed');
  } catch (error) {
    await emit.flush().catch(() => {});
    await emit({ type: 'error', code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? 'The request failed.' }).catch(() => {});
    await emit.flush().catch(() => {});
    await prisma.chatTurn.updateMany({ where: { id: turnId, status: { not: 'completed' } }, data: { status: 'failed', errorCode: error.code ?? 'INTERNAL_ERROR' } }).catch(() => {});
    const terminal = event.attempts >= 5;
    const delayMs = Math.min(300000, 1000 * 2 ** event.attempts);
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: terminal ? 'failed' : 'pending', lockedAt: null, runAt: new Date(Date.now() + delayMs), lastError: (error.message ?? 'Chat job failed').slice(0, 2000) } }).catch(() => {});
    if (terminal) observeJob('failed');
    logger.error({ eventId: event.id, turnId, attempt: event.attempts, terminal, code: error.code ?? error.name }, 'Chat job failed');
  } finally { clearInterval(heartbeat); }
}

async function poll() {
  if (polling || !prisma) return;
  polling = true;
  try { while (await processOne()) { /* drain ready jobs without overlapping pollers */ } }
  catch (error) { logger.error({ code: error.code ?? error.name }, 'Outbox poll failed'); }
  finally { polling = false; }
}

export function startMemoryIndexer() {
  if (!prisma || timer) return;
  timer = setInterval(() => void poll(), 1500);
  timer.unref();
  void poll();
  logger.info('Memory indexer worker started');
}

export async function stopMemoryIndexer() {
  if (timer) clearInterval(timer);
  timer = undefined;
  while (polling) await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.allSettled([...activeChatJobs]);
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await mapper(items[index], index); }
  }));
  return output;
}
