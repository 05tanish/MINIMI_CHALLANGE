import { prisma } from '../../infrastructure/database/prisma.js';
import { embedText } from '../../infrastructure/llm/gemini.js';
import { extractDateRange } from '../temporal/temporal.js';
import { reciprocalRankFusion } from './rank.js';
import { env } from '../../config/env.js';
import { extractEntities } from './chunking.js';

export async function retrieveMemory(query, timezone = env.USER_TIMEZONE, signal, userId, excludeMessageId) {
  if (!prisma) throw Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' });
  if (!userId) throw Object.assign(new Error('Authenticated user is required'), { code: 'UNAUTHORIZED' });
  const range = extractDateRange(query, new Date(), timezone);
  const params = [query, userId];
  let dateSql = '';
  if (range) { params.push(range.start, range.end); dateSql = `AND mc."startAt" < $4 AND mc."endAt" >= $3`; }
  let keywordRows = [];
  try {
    keywordRows = await prisma.$queryRawUnsafe(`SELECT mc.id, mc."conversationId", mc.content, mc.topic, mc."startAt", mc."endAt", ts_rank_cd(mc."searchVector", plainto_tsquery('english', $1)) AS rank FROM "MemoryChunk" mc JOIN "Conversation" c ON c.id = mc."conversationId" WHERE c."userId" = $2 AND mc."searchVector" @@ plainto_tsquery('english', $1) ${dateSql} ORDER BY rank DESC LIMIT 25`, ...params);
  } catch { /* direct message search below works before/rebuilds memory indexing */ }

  // Search original stored messages as well as derived chunks. Chunks can be
  // missing for older conversations or after an indexing failure; querying the
  // source messages ensures prior questions and answers remain retrievable.
  const messageDateSql = range ? 'AND m."createdAt" >= $4 AND m."createdAt" < $5' : '';
  const messageParams = range ? [query, userId, excludeMessageId ?? '', range.start, range.end] : [query, userId, excludeMessageId ?? ''];
  const messageRows = await prisma.$queryRawUnsafe(`
    SELECT m.id, m."conversationId", m.content, m.role AS topic,
      m."createdAt" AS "startAt", m."createdAt" AS "endAt",
      ts_rank(to_tsvector('simple', m.content), plainto_tsquery('simple', $1)) AS rank
    FROM "Message" m
    JOIN "Conversation" c ON c.id = m."conversationId"
    WHERE c."userId" = $2
      AND m.role IN ('user', 'assistant')
      AND m.id <> COALESCE($3, '')
      AND to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $1)
      ${messageDateSql}
    ORDER BY rank DESC, m."createdAt" DESC
    LIMIT 20`, ...messageParams);
  const entityRows = [];
  for (const entity of extractEntities(query)) {
    const normalized = entity.name.toLowerCase();
    try {
      const rows = range
        ? await prisma.$queryRaw`SELECT DISTINCT mc.id, mc."conversationId", mc.content, mc.topic, mc."startAt", mc."endAt" FROM "Entity" e JOIN "EntityMention" em ON em."entityId" = e.id JOIN "Message" m ON m.id = em."messageId" JOIN "MemoryChunk" mc ON mc."conversationId" = em."conversationId" AND mc.metadata->'messageIds' ? m.id JOIN "Conversation" c ON c.id = mc."conversationId" WHERE c."userId" = ${userId} AND e."normalizedName" = ${normalized} AND mc."startAt" < ${range.end} AND mc."endAt" >= ${range.start} LIMIT 25`
        : await prisma.$queryRaw`SELECT DISTINCT mc.id, mc."conversationId", mc.content, mc.topic, mc."startAt", mc."endAt" FROM "Entity" e JOIN "EntityMention" em ON em."entityId" = e.id JOIN "Message" m ON m.id = em."messageId" JOIN "MemoryChunk" mc ON mc."conversationId" = em."conversationId" AND mc.metadata->'messageIds' ? m.id JOIN "Conversation" c ON c.id = mc."conversationId" WHERE c."userId" = ${userId} AND e."normalizedName" = ${normalized} LIMIT 25`;
      entityRows.push(...rows);
    } catch { /* direct message and full-text retrieval remain available */ }
  }
  let vectorRows = [];
  try {
    const vector = await embedText(query, signal);
    if (vector) {
      const vectorParam = `[${vector.join(',')}]`;
      const vectorParams = range ? [vectorParam, userId, range.start, range.end] : [vectorParam, userId];
      const vectorDate = range ? `AND mc."startAt" < $4 AND mc."endAt" >= $3` : '';
      vectorRows = await prisma.$queryRawUnsafe(`SELECT mc.id, mc."conversationId", mc.content, mc.topic, mc."startAt", mc."endAt" FROM "MemoryChunk" mc JOIN "Conversation" c ON c.id = mc."conversationId" WHERE c."userId" = $2 AND mc.embedding IS NOT NULL ${vectorDate} ORDER BY mc.embedding <=> $1::vector LIMIT 25`, ...vectorParams);
    }
  } catch { /* keyword path remains useful when embeddings are unavailable */ }
  return { chunks: reciprocalRankFusion([keywordRows, messageRows, vectorRows, entityRows], 60).slice(0, env.MAX_CONTEXT_CHUNKS), range, retrievalSucceeded: true };
}
