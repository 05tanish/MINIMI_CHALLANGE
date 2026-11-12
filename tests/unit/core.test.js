import { describe, expect, it } from 'vitest';
import { routeIntent } from '../../server/src/modules/agent/routing.js';
import { extractDateRange } from '../../server/src/modules/temporal/temporal.js';
import { extractEntities, makeTopicChunks } from '../../server/src/modules/retrieval/chunking.js';
import { reciprocalRankFusion } from '../../server/src/modules/retrieval/rank.js';
import { validateCitations } from '../../server/src/modules/citations/validate.js';
import { withRetry } from '../../server/src/utils/retry.js';
import { withAvailableModel, generateWithGroq, buildEvidenceFallback } from '../../server/src/infrastructure/llm/gemini.js';
import { extractClaimsFast, normalizeEntity } from '../../server/src/modules/claims/extract.js';
import { diffClaims } from '../../server/src/modules/temporal/diff.js';
import { verifyClaims, extractClaimCitationPairs } from '../../server/src/modules/citations/verify.js';
import { planSearchQueries } from '../../server/src/modules/agent/research.js';
import { estimateTokens, truncateToTokens } from '../../server/src/utils/tokens.js';
import { hashPassword, verifyPassword } from '../../server/src/modules/auth/service.js';
import { assertPublicHttpUrl } from '../../server/src/infrastructure/search/extract.js';
import { readFileSync } from 'node:fs';

const evaluationScenarios = JSON.parse(readFileSync(new URL('../evaluation/scenarios.json', import.meta.url), 'utf8'));

describe('intent routing', () => {
  it('routes history-only questions to memory without search', () => expect(routeIntent('What did I ask you last week?')).toMatchObject({ memory: true, web: false }));
  it('routes historical comparisons to both tools', () => expect(routeIntent('Has the pricing changed since last week?')).toMatchObject({ memory: true, web: true }));
  it('routes current pricing to search only', () => expect(routeIntent('What is current pricing?')).toMatchObject({ memory: false, web: true }));
  it('keeps general chat local', () => expect(routeIntent('Explain how a database index works')).toMatchObject({ memory: false, web: false }));
});

describe('account password security', () => {
  it('stores a salted password hash and verifies only the correct password', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(await verifyPassword('wrong password', encoded)).toBe(false);
  });
});

describe('web page request safety', () => {
  it.each(['http://127.0.0.1/admin', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/'])('blocks private network target %s', async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toMatchObject({ code: 'EXTRACT_BLOCKED' });
  });
  it('rejects non-http schemes and credential-bearing URLs', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });
    await expect(assertPublicHttpUrl('https://user:pass@example.com/')).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });
  });
});

describe('Groq provider adapter', () => {
  it('uses Groq chat completions with a server-side key and configured model', async () => {
    const originalFetch = globalThis.fetch; let request;
    globalThis.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: 'Fallback answer' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    try {
      const answer = await generateWithGroq([{ role: 'user', content: 'Hello' }], undefined, { apiKey: 'test-secret', model: 'openai/gpt-oss-120b' });
      expect(answer).toBe('Fallback answer');
      expect(request.url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(request.options.headers.authorization).toBe('Bearer test-secret');
      expect(JSON.parse(request.options.body)).toMatchObject({ model: 'openai/gpt-oss-120b', stream: false });
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe('answer fallback', () => {
  it('returns retrieved history and cited web evidence when language models are unavailable', () => {
    const answer = buildEvidenceFallback('What changed?', [{ content: 'We discussed a $20 plan.' }], [{ id: 'S1', title: 'Pricing', snippet: 'The plan costs $25 per month.' }]);
    expect(answer).toContain('We discussed a $20 plan.');
    expect(answer).toContain('The plan costs $25 per month. [S1]');
    expect(answer).toContain('## Research summary');
    expect(answer).toContain('### Current web evidence');
    expect(answer).toContain('not a synthesized conclusion');
  });
  it('returns a clear retry message when there is no evidence', () => {
    expect(buildEvidenceFallback('Question?')).toContain('Please try again shortly.');
  });
});

describe('temporal extraction', () => {
  it('resolves yesterday in the configured timezone', () => {
    const range = extractDateRange('What did we discuss yesterday?', new Date('2026-11-11T10:00:00Z'), 'Asia/Kolkata');
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(range.start)).toBe('2026-11-10');
  });
  it('resolves a weekday before today', () => {
    const range = extractDateRange('last Tuesday', new Date('2026-11-11T10:00:00Z'), 'Asia/Kolkata');
    expect(new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Kolkata' }).format(range.start)).toBe('Tuesday');
  });
  it('marks missing year as ambiguous', () => expect(extractDateRange('On 3 November', new Date('2026-11-11T10:00:00Z')).ambiguousYear).toBe(true));
  it('returns no range for date-free questions', () => expect(extractDateRange('what about the CRM')).toBeNull());
  // NEW: weekday recognition for "on Monday"
  it('resolves "on Monday" to the most recent past Monday', () => {
    const range = extractDateRange('On Monday we shortlisted 5 CRM tools', new Date('2026-11-12T10:00:00Z'), 'Asia/Kolkata');
    expect(new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Kolkata' }).format(range.start)).toBe('Monday');
  });
  // NEW: "last week" → 7-day range
  it('resolves "last week" to a 7-day range ending today', () => {
    const range = extractDateRange('What did we discuss last week?', new Date('2026-11-12T10:00:00Z'), 'Asia/Kolkata');
    const days = Math.round((range.end - range.start) / (1000 * 60 * 60 * 24));
    expect(days).toBe(7);
  });
  // NEW: "last month" → previous calendar month
  it('resolves "last month" to the previous calendar month', () => {
    const range = extractDateRange('Summarize our discussions last month', new Date('2026-11-15T10:00:00Z'), 'Asia/Kolkata');
    expect(new Intl.DateTimeFormat('en-CA', { month: 'long', timeZone: 'Asia/Kolkata' }).format(range.start)).toBe('October');
  });
  // NEW: "N days ago"
  it('resolves "3 days ago" to the correct date', () => {
    const range = extractDateRange('What did we decide 3 days ago?', new Date('2026-11-12T10:00:00Z'), 'Asia/Kolkata');
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(range.start)).toBe('2026-11-09');
  });
  // NEW: "a week ago"
  it('resolves "a week ago" to 7 days back', () => {
    const range = extractDateRange('We talked a week ago about pricing', new Date('2026-11-12T10:00:00Z'), 'Asia/Kolkata');
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(range.start)).toBe('2026-11-05');
  });
  // NEW: "recently" → last 7 days
  it('resolves "recently" to a 7-day range', () => {
    const range = extractDateRange('What changed recently?', new Date('2026-11-12T10:00:00Z'), 'Asia/Kolkata');
    expect(range).not.toBeNull();
    const days = Math.round((range.end - range.start) / (1000 * 60 * 60 * 24));
    expect(days).toBe(7);
  });
});

describe('retrieval helpers', () => {
  it('extracts named products, technologies and prices', () => {
    expect(extractEntities('Neon and Supabase cost $20 for Postgres')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Neon' }), expect.objectContaining({ name: 'Supabase' }), expect.objectContaining({ name: '$20' })]));
  });
  it('combines topic-adjacent messages and preserves message ids', () => {
    const chunks = makeTopicChunks([{ id: '1', role: 'user', content: 'Compare Neon Postgres', createdAt: new Date() }, { id: '2', role: 'assistant', content: 'Neon has a free tier', createdAt: new Date() }]);
    expect(chunks[0].messageIds).toEqual(['1', '2']);
  });
  it('merges ranked lists using RRF', () => {
    const result = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }]]);
    expect(result[0].id).toBe('a'); expect(result[0].rrfScore).toBeCloseTo(result[1].rrfScore);
  });
  it('rejects citations that do not refer to supplied sources', () => expect(validateCitations('Price is lower [S8]', [{ id: 'S1' }]).valid).toBe(false));
  it('retries transient failures and stops after success', async () => {
    let calls = 0; const value = await withRetry(async () => { calls += 1; if (calls < 2) throw new Error('temporary'); return 'ok'; }, { retries: 1, baseDelayMs: 1, maxDelayMs: 1 });
    expect(value).toBe('ok'); expect(calls).toBe(2);
  });
  it('does not retry a non-retryable error', async () => {
    let calls = 0; await expect(withRetry(async () => { calls += 1; throw new Error('bad request'); }, { retries: 2, shouldRetry: () => false })).rejects.toThrow(); expect(calls).toBe(1);
  });
  it('uses the next configured Gemini model when the primary is unavailable', async () => {
    const attempts = [];
    const outcome = await withAvailableModel(async (model) => { attempts.push(model); if (attempts.length < 3) throw Object.assign(new Error('unavailable'), { status: 503 }); return 'ok'; }, new AbortController().signal);
    expect(outcome.result).toBe('ok');
    expect(attempts.at(-1)).not.toBe(attempts[0]);
  });
  it('uses a fallback model when the primary is rate-limited', async () => {
    const attempts = [];
    const outcome = await withAvailableModel(async (model) => { attempts.push(model); if (attempts.length < 3) throw Object.assign(new Error('rate limited'), { status: 429 }); return 'ok'; }, new AbortController().signal);
    expect(outcome.result).toBe('ok');
    expect(attempts.at(-1)).not.toBe(attempts[0]);
  });
});

describe('structured claim extraction', () => {
  it('extracts prices and entities via regex fallback', () => {
    const claims = extractClaimsFast('HubSpot Starter costs $20/mo and Pipedrive is $14/month');
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((c) => c.entity === 'HubSpot')).toBe(true);
    expect(claims.some((c) => c.entity === 'Pipedrive')).toBe(true);
    expect(claims.some((c) => c.attribute === 'price')).toBe(true);
  });
  it('normalizes entity names for matching', () => {
    expect(normalizeEntity('HubSpot CRM')).toBe('hubspot');
    expect(normalizeEntity('Pipedrive')).toBe('pipedrive');
    expect(normalizeEntity('Neon Database Hosting')).toBe('neon');
  });
  it('returns empty array for empty text', () => {
    expect(extractClaimsFast('')).toEqual([]);
    expect(extractClaimsFast(null)).toEqual([]);
  });
});

describe('temporal diff engine', () => {
  it('detects changed claims between historical and current', () => {
    const memory = [{ entity: 'HubSpot', attribute: 'price', value: '$20/mo', date: '2026-11-03' }];
    const web = [{ entity: 'HubSpot', attribute: 'price', value: '$25/mo', date: null, source: 'web' }];
    const diff = diffClaims(memory, web);
    const changed = diff.entries.find((e) => e.status === 'changed');
    expect(changed).toBeTruthy();
    expect(changed.historicalValue).toBe('$20/mo');
    expect(changed.currentValue).toBe('$25/mo');
  });
  it('detects unchanged claims', () => {
    const memory = [{ entity: 'Pipedrive', attribute: 'price', value: '$14/mo', date: '2026-11-03' }];
    const web = [{ entity: 'Pipedrive', attribute: 'price', value: '$14/month', date: null, source: 'web' }];
    const diff = diffClaims(memory, web);
    const unchanged = diff.entries.find((e) => e.status === 'unchanged');
    expect(unchanged).toBeTruthy();
  });
  it('marks entities with no current evidence', () => {
    const memory = [{ entity: 'Attio', attribute: 'price', value: '$15/mo', date: '2026-11-03' }];
    const web = [];
    const diff = diffClaims(memory, web);
    expect(diff.summary).toContain('No current web evidence');
  });
  it('identifies new findings not in history', () => {
    const memory = [];
    const web = [{ entity: 'Close', attribute: 'price', value: '$29/mo', date: null, source: 'web' }];
    const diff = diffClaims(memory, web);
    expect(diff.summary).toContain('No historical claims');
  });
  it('matches fuzzy entity names (HubSpot CRM vs HubSpot)', () => {
    const memory = [{ entity: 'HubSpot CRM', attribute: 'price', value: '$20/mo', date: null }];
    const web = [{ entity: 'HubSpot', attribute: 'price', value: '$25/mo', date: null, source: 'web' }];
    const diff = diffClaims(memory, web);
    const matched = diff.entries.find((e) => e.status === 'changed');
    expect(matched).toBeTruthy();
  });
});

describe('self-verification', () => {
  it('extracts claim-citation pairs from answer text', () => {
    const pairs = extractClaimCitationPairs('HubSpot is now $25/mo [S1]. Pipedrive remains $14/mo [S2].');
    expect(pairs).toHaveLength(2);
    expect(pairs[0].citationId).toBe('S1');
    expect(pairs[1].citationId).toBe('S2');
  });
  it('verifies supported claims against source text', () => {
    const answer = 'HubSpot Starter costs $25/mo [S1].';
    const sources = [{ id: 'S1', title: 'HubSpot Pricing', snippet: 'HubSpot Starter plan is $25 per month for new users', extractedContent: null }];
    const result = verifyClaims(answer, sources);
    expect(result.verified).toBe(true);
    expect(result.supportedCount).toBe(1);
  });
  it('flags claims not supported by source text', () => {
    const answer = 'HubSpot Enterprise costs $500/mo [S1].';
    const sources = [{ id: 'S1', title: 'HubSpot Pricing', snippet: 'HubSpot Starter plan is $25 per month', extractedContent: null }];
    const result = verifyClaims(answer, sources);
    expect(result.verified).toBe(false);
    expect(result.unsupportedCount).toBe(1);
  });
  it('flags citations that do not match any source', () => {
    const answer = 'Some claim [S99].';
    const sources = [{ id: 'S1', title: 'Test', snippet: 'test content here', extractedContent: null }];
    const result = verifyClaims(answer, sources);
    expect(result.unsupported[0].reason).toBe('citation does not match any source');
  });
});

describe('adaptive query planning', () => {
  it('generates entity-specific queries from memory', () => {
    const analysis = { searchQueries: ['CRM pricing comparison'], entities: [{ name: 'HubSpot', type: 'product' }] };
    const memoryChunks = [{ entities: [{ name: 'Pipedrive', type: 'product' }, { name: 'Zoho CRM', type: 'product' }] }];
    const queries = planSearchQueries('Has any pricing changed?', analysis, memoryChunks);
    expect(queries.some((q) => q.includes('HubSpot'))).toBe(true);
    expect(queries[0]).toBe('Has any pricing changed?');
    expect(queries.some((q) => q.includes('Pipedrive') || q.includes('Zoho'))).toBe(true);
  });
  it('keeps the original question ahead of entity expansions', () => {
    const analysis = { searchQueries: [], entities: [{ name: 'Neon', type: 'technology' }] };
    const queries = planSearchQueries('Has anything changed?', analysis, []);
    expect(queries[0]).toBe('Has anything changed?');
    expect(queries.some((q) => q.includes('Neon Has anything changed?'))).toBe(true);
  });
  it('respects MAX_SEARCH_QUERIES limit', () => {
    const analysis = { searchQueries: [], entities: [] };
    const memoryChunks = [{ entities: Array.from({ length: 20 }, (_, i) => ({ name: `Entity${i}`, type: 'product' })) }];
    const queries = planSearchQueries('test', analysis, memoryChunks);
    // Default MAX_SEARCH_QUERIES is 4
    expect(queries.length).toBeLessThanOrEqual(4);
  });
});

describe('offline research scenario evaluation', () => {
  it('keeps every evaluation case uniquely addressable', () => {
    const ids = evaluationScenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(20);
  });
  it.each(evaluationScenarios)('preserves the question as the first search for $id', (scenario) => {
    const queries = planSearchQueries(scenario.query, { entities: [], searchQueries: [] }, []);
    expect(queries[0]).toBe(scenario.query);
  });
  it.each(evaluationScenarios.filter((scenario) => scenario.checks.some((check) => ['date-filter', 'weekday-filter', 'temporal', 'ambiguous-date'].includes(check))))('recognizes temporal intent in $id', (scenario) => {
    expect(extractDateRange(scenario.query, new Date('2026-11-13T00:00:00Z'), 'Asia/Kolkata')).not.toBeNull();
  });
});

describe('token utilities', () => {
  it('estimates tokens from text length', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 ≈ 3
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });
  it('truncates text to token budget', () => {
    const long = 'word '.repeat(1000); // 5000 chars
    const truncated = truncateToTokens(long, 100); // ~400 chars
    expect(truncated.length).toBeLessThan(long.length);
    expect(truncated.endsWith('…')).toBe(true);
  });
  it('does not truncate short text', () => {
    expect(truncateToTokens('short text', 100)).toBe('short text');
  });
});
