import crypto from 'node:crypto';
import { prisma } from '../../infrastructure/database/prisma.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { routeIntent } from '../agent/routing.js';
import { retrieveMemory } from '../retrieval/retrieve.js';
import { analyzeQuery, generateAnswer } from '../../infrastructure/llm/gemini.js';
import { geminiInternals } from '../../infrastructure/llm/gemini.js';
import { validateCitations } from '../citations/validate.js';
import { verifyClaims, verificationNotice } from '../citations/verify.js';
import { planSearchQueries, researchLoop } from '../agent/research.js';
import { extractAllClaims } from '../claims/extract.js';
import { diffClaims, formatDiffForLLM } from '../temporal/diff.js';
import { extractDateRange } from '../temporal/temporal.js';
import { env } from '../../config/env.js';
import { normalizeEntity } from '../claims/extract.js';

export async function runChat({ conversationId, message, userId, idempotencyKey, onEvent, shouldStop = () => false, afterSequence = 0 }) {
  if (!prisma) throw Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' });
  const key = idempotencyKey || crypto.randomUUID();
  const existingTurn = await prisma.chatTurn.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } }, include: { conversation: true, userMessage: true, assistantMessage: { include: { sources: true } } } });
  if (existingTurn && existingTurn.userMessage.content !== message) throw Object.assign(new Error('This Idempotency-Key was already used for a different message.'), { code: 'IDEMPOTENCY_CONFLICT' });
  let conversation = existingTurn?.conversation ?? (conversationId ? await prisma.conversation.findFirst({ where: { id: conversationId, userId } }) : null);
  if (conversationId && !conversation) throw Object.assign(new Error('Conversation was not found'), { code: 'NOT_FOUND' });
  let turn = existingTurn;
  if (!turn) {
    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const currentConversation = conversation ?? await tx.conversation.create({ data: { userId, title: message.slice(0, 80) } });
        const currentUserMessage = await tx.message.create({ data: { conversationId: currentConversation.id, role: 'user', content: message } });
        const currentTurn = await tx.chatTurn.create({ data: { userId, conversationId: currentConversation.id, userMessageId: currentUserMessage.id, idempotencyKey: key, status: 'queued' } });
        await tx.outboxEvent.create({ data: { type: 'chat.run', aggregateId: currentConversation.id, payload: { turnId: currentTurn.id } } });
        return { conversation: currentConversation, userMessage: currentUserMessage, turn: currentTurn };
      });
    } catch (error) {
      // Two browser retries can both observe no row before either transaction
      // commits. The unique constraint chooses a winner; replay that turn.
      if (error.code !== 'P2002') throw error;
      const racedTurn = await prisma.chatTurn.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } }, include: { conversation: true, userMessage: true, assistantMessage: { include: { sources: true } } } });
      if (!racedTurn) throw error;
      if (racedTurn.userMessage.content !== message) throw Object.assign(new Error('This Idempotency-Key was already used for a different message.'), { code: 'IDEMPOTENCY_CONFLICT' });
      created = { conversation: racedTurn.conversation, turn: racedTurn };
    }
    conversation = created.conversation; turn = created.turn;
  } else if (turn.status === 'failed') {
    await prisma.$transaction(async (tx) => {
      await tx.chatTurn.update({ where: { id: turn.id }, data: { status: 'queued', errorCode: null } });
      const pending = await tx.outboxEvent.findFirst({ where: { aggregateId: conversation.id, type: 'chat.run', status: { in: ['pending', 'processing'] } } });
      if (!pending) await tx.outboxEvent.create({ data: { type: 'chat.run', aggregateId: conversation.id, payload: { turnId: turn.id } } });
    });
  }
  let sequence = afterSequence;
  while (!shouldStop()) {
    const events = await prisma.chatTurnEvent.findMany({ where: { turnId: turn.id, sequence: { gt: sequence } }, orderBy: { sequence: 'asc' }, take: 100 });
    for (const event of events) { sequence = event.sequence; onEvent({ ...event.payload, sequence, type: event.type }); }
    const current = await prisma.chatTurn.findUnique({ where: { id: turn.id }, select: { status: true } });
    if (['completed', 'failed'].includes(current?.status) && events.length < 100) break;
    if (!shouldStop()) await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function processChatTurn({ turnId, onEvent }) {
  const turn = await prisma.chatTurn.findUnique({ where: { id: turnId }, include: { conversation: true, userMessage: true, assistantMessage: { include: { sources: true } } } });
  if (!turn || turn.status === 'completed') return;
  if (turn.assistantMessage) {
    const savedSources = turn.assistantMessage.sources.map((source, index) => ({ ...source, id: `S${index + 1}` }));
    onEvent({ type: 'done', conversationId: turn.conversationId, messageId: turn.assistantMessage.id, answer: turn.assistantMessage.content, sources: savedSources, retrievalCount: 0, memoryIndexed: false, idempotentReplay: true });
    await onEvent.flush?.();
    await prisma.chatTurn.update({ where: { id: turn.id }, data: { status: 'completed', errorCode: null } });
    return;
  }
  await prisma.chatTurn.update({ where: { id: turn.id }, data: { status: 'running', errorCode: null } });
  return executeChatTurn({ turn, onEvent });
}

async function executeChatTurn({ turn, onEvent }) {
  const { conversation, userMessage } = turn;
  const userId = turn.userId;
  const message = userMessage.content;
  if (!prisma) throw Object.assign(new Error('Database is not configured'), { code: 'DATABASE_UNAVAILABLE' });
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
  let claims = { memoryClaims: [], webClaims: [] };
  if (memory.chunks.length || sources.length) {
    if (memory.chunks.length && sources.length) onEvent({ type: 'progress', stage: 'compare', detail: 'Extracting and comparing claims...' });
    try {
      claims = await extractAllClaims({ memoryChunks: memory.chunks, webSources: sources, geminiModule: geminiInternals, signal: budgetController.signal });
      if (memory.chunks.length && sources.length) {
        const { memoryClaims, webClaims } = claims;
      diff = diffClaims(memoryClaims, webClaims);
      if (diff?.entries?.length) {
        onEvent({ type: 'findings', findingsType: 'diff', items: diff.entries, summary: diff.summary });
        onEvent({ type: 'progress', stage: 'compare', detail: diff.summary });
      } else {
        onEvent({ type: 'progress', stage: 'compare', detail: 'No structured claims to compare' });
      }
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
    const sourceIds = new Map();
    for (const source of sources) {
      const saved = await tx.researchSource.upsert({ where: { messageId_url: { messageId: row.id, url: source.url } }, create: { conversationId: conversation.id, messageId: row.id, title: source.title, url: source.url, snippet: source.snippet, publishedAt: source.publishedAt ? new Date(source.publishedAt) : null, metadata: { retrievedAt: source.retrievedAt, hasExtractedContent: Boolean(source.extractedContent) } }, update: {} });
      sourceIds.set(source.url, saved.id);
    }
    const persistedClaims = [];
    for (const claim of claims.memoryClaims) {
      const entityName = claim.entity?.trim(); if (!entityName || entityName === '(unknown)') continue;
      const entityKey = normalizeEntity(entityName); if (!entityKey) continue;
      const entity = await tx.entity.upsert({ where: { normalizedName: entityKey }, create: { name: entityName, normalizedName: entityKey, type: 'research' }, update: {} });
      const conversationKey = claim.conversationId ?? conversation.id;
      const evidenceKey = crypto.createHash('sha256').update([userId, conversationKey, 'memory', claim.messageId ?? '', entityKey, claim.attribute, claim.value.toLowerCase()].join('|')).digest('hex');
      persistedClaims.push({ userId, conversationId: conversationKey, entityId: entity.id, attribute: claim.attribute, value: claim.value, validAt: claim.date ? new Date(claim.date) : null, messageId: claim.messageId, sourceId: null, origin: 'memory', evidenceKey });
    }
    for (const claim of claims.webClaims) {
      const entityName = claim.entity?.trim(); if (!entityName || entityName === '(unknown)') continue;
      const entityKey = normalizeEntity(entityName); if (!entityKey) continue;
      const entity = await tx.entity.upsert({ where: { normalizedName: entityKey }, create: { name: entityName, normalizedName: entityKey, type: 'research' }, update: {} });
      const sourceId = sourceIds.get(claim.sourceUrl) ?? null;
      const evidenceKey = crypto.createHash('sha256').update([userId, conversation.id, 'web', sourceId ?? '', entityKey, claim.attribute, claim.value.toLowerCase()].join('|')).digest('hex');
      persistedClaims.push({ userId, conversationId: conversation.id, entityId: entity.id, attribute: claim.attribute, value: claim.value, validAt: claim.date ? new Date(claim.date) : null, messageId: row.id, sourceId, origin: 'web', evidenceKey });
    }
    if (persistedClaims.length) await tx.researchClaim.createMany({ data: persistedClaims, skipDuplicates: true });
    await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    await tx.chatTurn.update({ where: { id: turn.id }, data: { assistantMessageId: row.id, errorCode: null } });
    await tx.outboxEvent.create({ data: { type: 'memory.index', aggregateId: conversation.id, payload: { conversationId: conversation.id, turnId: turn.id } } });
    return row;
  }, { timeout: 15000 });

  onEvent({ type: 'done', conversationId: conversation.id, messageId: assistant.id, answer, sources, retrievalCount: memory.chunks.length, memoryIndexed: false, indexingQueued: true, citationValidation: validateCitations(answer, sources), searchRounds: search.rounds, diff: diff?.entries ?? [], diffSummary: diff?.summary ?? null });
  await onEvent.flush?.();
  await prisma.chatTurn.update({ where: { id: turn.id }, data: { status: 'completed', errorCode: null } });
}
