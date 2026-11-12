import { prisma } from '../../infrastructure/database/prisma.js';
import { embedText } from '../../infrastructure/llm/gemini.js';
import { extractDateRange } from '../temporal/temporal.js';
import { reciprocalRankFusion } from './rank.js';
import { env } from '../../config/env.js';
import { extractEntities } from './chunking.js';

export async function retrieveMemory(query, timezone = env.USER_TIMEZONE, signal) {
  if (!prisma) throw Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' });
  const range = extractDateRange(query, new Date(), timezone);
  const params = [query];
  let dateSql = '';
  if (range) { params.push(range.start, range.end); dateSql = `AND "startAt" < $3 AND "endAt" >= $2`; }
  const keywordRows = await prisma.$queryRawUnsafe(`SELECT id, "conversationId", content, topic, "startAt", "endAt", ts_rank_cd("searchVector", plainto_tsquery('english', $1)) AS rank FROM "MemoryChunk" WHERE "searchVector" @@ plainto_tsquery('english', $1) ${dateSql} ORDER BY rank DESC LIMIT 25`, ...params);
  const entityRows = [];
  for (const entity of extractEntities(query)) {
    const normalized = entity.name.toLowerCase();
    const rows = range
      ? await prisma.$queryRaw`SELECT DISTINCT mc.id, mc."conversationId", mc.content, mc.topic, mc."startAt", mc."endAt" FROM "Entity" e JOIN "EntityMention" em ON em."entityId" = e.id JOIN "Message" m ON m.id = em."messageId" JOIN "MemoryChunk" mc ON mc."conversationId" = em."conversationId" AND mc.metadata->'messageIds' ? m.id WHERE e."normalizedName" = ${normalized} AND mc."startAt" < ${range.end} AND mc."endAt" >= ${range.start} LIMIT 25`
      : await prisma.$queryRaw`SELECT DISTINCT mc.id, mc."conversationId", mc.content, mc.topic, mc."startAt", mc."endAt" FROM "Entity" e JOIN "EntityMention" em ON em."entityId" = e.id JOIN "Message" m ON m.id = em."messageId" JOIN "MemoryChunk" mc ON mc."conversationId" = em."conversationId" AND mc.metadata->'messageIds' ? m.id WHERE e."normalizedName" = ${normalized} LIMIT 25`;
    entityRows.push(...rows);
  }
  let vectorRows = [];
  try {
    const vector = await embedText(query, signal);
    if (vector) {
      const vectorParam = `[${vector.join(',')}]`;
      const vectorParams = range ? [vectorParam, range.start, range.end] : [vectorParam];
      const vectorDate = range ? `AND "startAt" < $3 AND "endAt" >= $2` : '';
      vectorRows = await prisma.$queryRawUnsafe(`SELECT id, "conversationId", content, topic, "startAt", "endAt" FROM "MemoryChunk" WHERE embedding IS NOT NULL ${vectorDate} ORDER BY embedding <=> $1::vector LIMIT 25`, ...vectorParams);
    }
  } catch { /* keyword path remains useful when embeddings are unavailable */ }
  return { chunks: reciprocalRankFusion([keywordRows, vectorRows, entityRows], 60).slice(0, env.MAX_CONTEXT_CHUNKS), range, retrievalSucceeded: true };
}
