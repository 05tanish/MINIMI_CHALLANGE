import { prisma } from '../../infrastructure/database/prisma.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { routeIntent } from '../agent/routing.js';
import { retrieveMemory } from '../retrieval/retrieve.js';
import { analyzeQuery, generateAnswer, embedText } from '../../infrastructure/llm/gemini.js';
import { geminiInternals } from '../../infrastructure/llm/gemini.js';
import { extractEntities, makeTopicChunks } from '../retrieval/chunking.js';
import { validateCitations } from '../citations/validate.js';
import { verifyClaims, verificationNotice } from '../citations/verify.js';
import { planSearchQueries, researchLoop } from '../agent/research.js';
import { extractAllClaims } from '../claims/extract.js';
import { diffClaims, formatDiffForLLM } from '../temporal/diff.js';
import { extractDateRange } from '../temporal/temporal.js';
import { env } from '../../config/env.js';

export async function runChat({ conversationId, message, userId, onEvent }) {
  if (!prisma) throw Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' });
  let conversation = conversationId ? await prisma.conversation.findFirst({ where: { id: conversationId, userId } }) : null;
  if (conversationId && !conversation) throw Object.assign(new Error('Conversation was not found'), { code: 'NOT_FOUND' });
  if (!conversation) conversation = await prisma.conversation.create({ data: { userId, title: message.slice(0, 80) } });
  const userMessage = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: message } });
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(new Error('Research budget exceeded')), env.RESEARCH_BUDGET_MS);
  budgetTimer.unref();
  onEvent({ type: 'conversation', conversationId: conversation.id });

  // 1. Understand the query
  onEvent({ type: 'progress', stage: 'understanding', detail: 'Analyzing your question...' });
  let analysis;
  // Query analysis is an optional optimization. Give it a short, independent
  // deadline so an unavailable Gemini model cannot consume the web-search
  // budget before research even starts.
  try { analysis = await analyzeQuery(message, AbortSignal.timeout(Math.min(5000, env.GEMINI_MODEL_TIMEOUT_MS))); }
  catch (error) { logger.warn({ code: error.code ?? error.name }, 'Query analysis failed; using rule-based routing'); analysis = { ...routeIntent(message), searchQueries: [], entities: [] }; }
  // Every request should use the user's history when available and check the
  // web for fresh evidence. The model's intent classification can inform query
  // planning, but must not disable either data source for ordinary questions.
  const routing = { ...routeIntent(message), ...analysis, memory: true, web: true };

  // 2. Retrieve memory (historical conversation context)
  let memory = { chunks: [], retrievalSucceeded: false };
  if (routing.memory) {
    onEvent({ type: 'progress', stage: 'memory', detail: 'Retrieving conversation context...' });
    try {
      memory = await retrieveMemory(message, env.USER_TIMEZONE, budgetController.signal, userId, userMessage.id);
      if (memory.chunks.length) {
        onEvent({ type: 'findings', findingsType: 'memory', items: memory.chunks.map((c) => ({ topic: c.topic, date: c.startAt, conversationId: c.conversationId, snippet: c.content.slice(0, 120) })) });
        onEvent({ type: 'progress', stage: 'memory', detail: `Found ${memory.chunks.length} relevant conversation${memory.chunks.length > 1 ? 's' : ''}` });
      }
    } catch (error) { logger.warn({ code: error.code }, 'Memory retrieval failed'); }
  }

  // 3. Adaptive query planning: generate search queries informed by memory
  let search = { sources: [], failures: [], rounds: 0 };
  if (routing.web) {
    onEvent({ type: 'progress', stage: 'search', detail: 'Planning search queries...' });
    const allEntities = [...(analysis.entities ?? []), ...memory.chunks.flatMap((c) => c.entities ?? [])];
    const queries = planSearchQueries(message, analysis, memory.chunks);
    onEvent({ type: 'progress', stage: 'search', detail: `Searching for ${allEntities.length > 0 ? allEntities.length + ' entities' : 'current information'}...` });

    // 4. Agentic research loop: iterative search with coverage evaluation
    try {
      search = await researchLoop(queries, allEntities, message, {
        signal: budgetController.signal,
        onProgress: (progress) => {
          if (progress.phase === 'searching') {
            onEvent({ type: 'progress', stage: 'search', detail: `Search round ${progress.round}: ${progress.queryCount} queries` });
          } else if (progress.phase === 'evaluated') {
            if (progress.sufficient) {
              onEvent({ type: 'progress', stage: 'search', detail: `Found sufficient evidence in round ${progress.round}` });
            } else {
              onEvent({ type: 'progress', stage: 'search', detail: `Round ${progress.round}: searching for ${progress.missing?.join(', ') || 'more results'}...` });
            }
          }
        }
      });
      if (search.sources.length) {
        onEvent({ type: 'findings', findingsType: 'search', items: search.sources.slice(0, 10).map((s) => ({ title: s.title, url: s.url, hasContent: Boolean(s.extractedContent) })) });
      }
    } catch (error) { search.failures.push({ error: error.code ?? 'SEARCH_FAILED' }); }
  }

  const sources = search.sources.map((s, i) => ({ ...s, id: `S${i + 1}` }));

  // 5. Structured claim extraction + temporal diff
  let diff = null;
  if (routing.memory && routing.web && memory.chunks.length && sources.length) {
    onEvent({ type: 'progress', stage: 'compare', detail: 'Extracting and comparing claims...' });
    try {
      const { memoryClaims, webClaims } = await extractAllClaims({
        memoryChunks: memory.chunks,
        webSources: sources,
        geminiModule: geminiInternals,
        signal: budgetController.signal
      });
      diff = diffClaims(memoryClaims, webClaims);
      if (diff?.entries?.length) {
        onEvent({ type: 'findings', findingsType: 'diff', items: diff.entries, summary: diff.summary });
        onEvent({ type: 'progress', stage: 'compare', detail: diff.summary });
      } else {
        onEvent({ type: 'progress', stage: 'compare', detail: 'No structured claims to compare' });
      }
    } catch (error) {
      logger.warn({ code: error.code ?? error.name }, 'Claim extraction or diff failed');
      onEvent({ type: 'progress', stage: 'compare', detail: 'Comparison unavailable, using raw evidence' });
    }
  }

  // The research deadline covers retrieval/search. Answer generation has its
  // own timeout and should still run when web research used its full budget.
  clearTimeout(budgetTimer);

  // 6. Generate answer with structured diff as input
  onEvent({ type: 'progress', stage: routing.web ? 'compare' : 'answer', detail: 'Writing your answer...' });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('LLM timeout')), env.LLM_TIMEOUT_MS);
  const llmSignal = controller.signal;
  let answer;
  const llmStartedAt = Date.now();
  try {
    answer = await generateAnswer({ query: message, history: memory.chunks, sources, diff, signal: llmSignal, onToken: (text) => onEvent({ type: 'delta', text }) });
    logger.info({ conversationId: conversation.id, llmDurationMs: Date.now() - llmStartedAt, retrievalCount: memory.chunks.length, sourceCount: sources.length, diffEntries: diff?.entries?.length ?? 0, searchRounds: search.rounds }, 'Answer generated');
  } catch (error) {
    const rateLimited = error.status === 429;
    const code = budgetController.signal.aborted ? 'RESEARCH_TIMEOUT' : rateLimited ? 'LLM_RATE_LIMITED' : 'LLM_UNAVAILABLE';
    const messageText = budgetController.signal.aborted ? 'The research time budget was exceeded. Your message was saved.' : rateLimited ? 'Answer generation is rate-limited right now. Your message was saved; please retry shortly.' : 'The answer service is temporarily unavailable. Your message was saved.';
    logger.warn({ conversationId: conversation.id, code, status: error.status ?? null }, 'Answer generation failed');
    throw Object.assign(new Error(messageText), { code, cause: error });
  } finally { clearTimeout(timer); }

  // 7. Self-verification: check claims against source text
  const notices = [];
  if (env.VERIFY_CLAIMS && sources.length) {
    try {
      const verification = verifyClaims(answer, sources);
      if (!verification.verified && verification.unsupportedCount > 0) {
        const notice = verificationNotice(verification);
        if (notice) { notices.push(notice); }
        logger.warn({ conversationId: conversation.id, unsupported: verification.unsupportedCount, total: verification.total }, 'Claim verification found unsupported claims');
      }
    } catch (error) {
      logger.warn({ code: error.code ?? error.name }, 'Claim verification failed');
    }
  }

  // 8. Citation validation + notices
  if (sources.length && !validateCitations(answer, sources).valid) notices.push('Some citations could not be validated against the available sources; please treat those claims as unverified.');
  if (search.failures.length) notices.push('Web research was incomplete because one or more search requests failed.');
  if (routing.memory && !memory.chunks.length) notices.push('I could not retrieve relevant earlier conversation context, so I cannot verify what we discussed before.');
  if (notices.length) { answer += `\n\n${notices.join('\n')}`; onEvent({ type: 'delta', text: `\n\n${notices.join('\n')}` }); }

  // 9. Persist assistant message + sources
  const assistant = await prisma.$transaction(async (tx) => {
    const row = await tx.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: answer } });
    for (const source of sources) await tx.researchSource.upsert({ where: { messageId_url: { messageId: row.id, url: source.url } }, create: { conversationId: conversation.id, messageId: row.id, title: source.title, url: source.url, snippet: source.snippet, publishedAt: source.publishedAt ? new Date(source.publishedAt) : null, metadata: { retrievedAt: source.retrievedAt, hasExtractedContent: Boolean(source.extractedContent) } }, update: {} });
    await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    return row;
  }, { timeout: 15000 });

  // 10. Index memory (embeddings + entities) — outside transaction, same as before
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
  onEvent({ type: 'done', conversationId: conversation.id, messageId: assistant.id, answer, sources, retrievalCount: memory.chunks.length, memoryIndexed, citationValidation: validateCitations(answer, sources), searchRounds: search.rounds, diff: diff?.entries ?? [], diffSummary: diff?.summary ?? null });
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await mapper(items[index], index); }
  }));
  return output;
}
