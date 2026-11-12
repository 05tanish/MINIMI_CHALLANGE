import { prisma } from '../../infrastructure/database/prisma.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { routeIntent } from '../agent/routing.js';
import { retrieveMemory } from '../retrieval/retrieve.js';
import { searchQueries } from '../../infrastructure/search/tavily.js';
import { analyzeQuery, generateAnswer, embedText } from '../../infrastructure/llm/gemini.js';
import { extractEntities, makeTopicChunks } from '../retrieval/chunking.js';
import { validateCitations } from '../citations/validate.js';
import { env } from '../../config/env.js';

export async function runChat({ conversationId, message, onEvent }) {
  if (!prisma) throw Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' });
  let conversation = conversationId ? await prisma.conversation.findUnique({ where: { id: conversationId } }) : null;
  if (conversationId && !conversation) throw Object.assign(new Error('Conversation was not found'), { code: 'NOT_FOUND' });
  if (!conversation) conversation = await prisma.conversation.create({ data: { title: message.slice(0, 80) } });
  const userMessage = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: message } });
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(new Error('Research budget exceeded')), env.RESEARCH_BUDGET_MS);
  budgetTimer.unref();
  onEvent({ type: 'conversation', conversationId: conversation.id });
  onEvent({ type: 'progress', stage: 'understanding' });
  let analysis;
  try { analysis = await analyzeQuery(message, budgetController.signal); }
  catch (error) { if (budgetController.signal.aborted) throw Object.assign(new Error('The research time budget was exceeded. Your message was saved.'), { code: 'RESEARCH_TIMEOUT' }); analysis = { ...routeIntent(message), searchQueries: [], entities: [] }; }
  const routing = { ...routeIntent(message), ...analysis };
  let memory = { chunks: [], retrievalSucceeded: false };
  if (routing.memory) {
    onEvent({ type: 'progress', stage: 'memory' });
    try { memory = await retrieveMemory(message, env.USER_TIMEZONE, budgetController.signal); }
    catch (error) { logger.warn({ code: error.code }, 'Memory retrieval failed'); }
  }
  let search = { sources: [], failures: [] };
  if (routing.web) {
    onEvent({ type: 'progress', stage: 'search' });
    const entities = [...analysis.entities, ...extractEntities(`${message}\n${memory.chunks.map((c) => c.content).join('\n')}`)];
    const queries = [...new Set([message, ...analysis.searchQueries, ...entities.slice(0, 3).map((e) => `${e.name} current pricing official`), ...entities.slice(0, 2).map((e) => `${e.name} release notes latest`)])].slice(0, env.MAX_SEARCH_QUERIES);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('Search timeout')), env.SEARCH_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, budgetController.signal]);
    try { search = await searchQueries(queries, signal); } catch (error) { search.failures.push({ error: error.code ?? 'SEARCH_FAILED' }); } finally { clearTimeout(timer); }
  }
  const sources = search.sources.map((s, i) => ({ ...s, id: `S${i + 1}` }));
  onEvent({ type: 'progress', stage: routing.web ? 'compare' : 'answer' });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('LLM timeout')), env.LLM_TIMEOUT_MS);
  const llmSignal = AbortSignal.any([controller.signal, budgetController.signal]);
  let answer;
  const llmStartedAt = Date.now();
  try { answer = await generateAnswer({ query: message, history: memory.chunks, sources, signal: llmSignal, onToken: (text) => onEvent({ type: 'delta', text }) }); logger.info({ conversationId: conversation.id, llmDurationMs: Date.now() - llmStartedAt, retrievalCount: memory.chunks.length, sourceCount: sources.length }, 'Answer generated'); }
  catch (error) {
    const rateLimited = error.status === 429;
    const code = budgetController.signal.aborted ? 'RESEARCH_TIMEOUT' : rateLimited ? 'LLM_RATE_LIMITED' : 'LLM_UNAVAILABLE';
    const messageText = budgetController.signal.aborted ? 'The research time budget was exceeded. Your message was saved.' : rateLimited ? 'Answer generation is rate-limited right now. Your message was saved; please retry shortly.' : 'The answer service is temporarily unavailable. Your message was saved.';
    logger.warn({ conversationId: conversation.id, code, status: error.status ?? null }, 'Answer generation failed');
    throw Object.assign(new Error(messageText), { code, cause: error });
  }
  finally { clearTimeout(timer); }
  const notices = [];
  if (sources.length && !validateCitations(answer, sources).valid) notices.push('Some citations could not be validated against the available sources; please treat those claims as unverified.');
  if (search.failures.length) notices.push('Web research was incomplete because one or more search requests failed.');
  if (routing.memory && !memory.chunks.length) notices.push('I could not retrieve relevant earlier conversation context, so I cannot verify what we discussed before.');
  if (notices.length) { answer += `\n\n${notices.join('\n')}`; onEvent({ type: 'delta', text: `\n\n${notices.join('\n')}` }); }
  const assistant = await prisma.$transaction(async (tx) => {
    const row = await tx.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: answer } });
    for (const source of sources) await tx.researchSource.upsert({ where: { messageId_url: { messageId: row.id, url: source.url } }, create: { conversationId: conversation.id, messageId: row.id, title: source.title, url: source.url, snippet: source.snippet, publishedAt: source.publishedAt ? new Date(source.publishedAt) : null, metadata: { retrievedAt: source.retrievedAt } }, update: {} });
    await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    return row;
  }, { timeout: 15000 });

  // Provider calls stay outside database transactions: Gemini latency can exceed
  // Prisma's interactive transaction timeout, while the user-visible answer is
  // already persisted above and remains available if memory indexing fails.
  let memoryIndexed = false;
  try {
    const recentMessages = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    const entityByMessage = { [userMessage.id]: analysis.entities };
    const chunks = makeTopicChunks(recentMessages.reverse(), entityByMessage).map((chunk) => ({ ...chunk, id: `chunk_${conversation.id}_${chunk.messageIds.join('_')}` }));
    const existing = await prisma.memoryChunk.findMany({ where: { id: { in: chunks.map((chunk) => chunk.id) } }, select: { id: true } });
    const existingIds = new Set(existing.map((row) => row.id));
    const missingChunks = chunks.filter((chunk) => !existingIds.has(chunk.id));
    const embeddedChunks = await mapWithConcurrency(missingChunks, 2, async (chunk) => ({ ...chunk, embedding: await embedText(chunk.content, budgetController.signal).catch((error) => { logger.warn({ code: error.code ?? error.name }, 'Memory embedding failed; storing keyword index only'); return null; }) }));
    await prisma.$transaction(async (tx) => {
      for (const chunk of embeddedChunks) {
        await tx.$executeRaw`INSERT INTO "MemoryChunk" (id, "conversationId", content, topic, entities, metadata, "startAt", "endAt", embedding, "searchVector") VALUES (${chunk.id}, ${conversation.id}, ${chunk.content}, ${chunk.topic}, ${JSON.stringify(chunk.entities)}::jsonb, ${JSON.stringify({ messageIds: chunk.messageIds })}::jsonb, ${chunk.startAt}, ${chunk.endAt}, ${chunk.embedding ? `[${chunk.embedding.join(',')}]` : null}::vector, to_tsvector('english', ${chunk.content})) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding, "searchVector" = EXCLUDED."searchVector"`;
        for (const messageId of chunk.messageIds) for (const entity of chunk.entities) {
          const normalizedName = entity.name.toLowerCase(); const entityRow = await tx.entity.upsert({ where: { normalizedName }, create: { name: entity.name, normalizedName, type: entity.type }, update: {} });
          await tx.entityMention.upsert({ where: { entityId_messageId: { entityId: entityRow.id, messageId } }, create: { entityId: entityRow.id, messageId, conversationId: conversation.id }, update: {} });
        }
      }
    }, { timeout: 20000, maxWait: 10000 });
    memoryIndexed = true;
  } catch (error) {
    logger.warn({ conversationId: conversation.id, code: error.code ?? error.name }, 'Memory indexing failed after answer persistence');
  }
  clearTimeout(budgetTimer);
  onEvent({ type: 'done', conversationId: conversation.id, messageId: assistant.id, answer, sources, retrievalCount: memory.chunks.length, memoryIndexed, citationValidation: validateCitations(answer, sources) });
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await mapper(items[index], index); }
  }));
  return output;
}
