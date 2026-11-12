import { describe, expect, it } from 'vitest';
import { routeIntent } from '../../server/src/modules/agent/routing.js';
import { extractDateRange } from '../../server/src/modules/temporal/temporal.js';
import { extractEntities, makeTopicChunks } from '../../server/src/modules/retrieval/chunking.js';
import { reciprocalRankFusion } from '../../server/src/modules/retrieval/rank.js';
import { validateCitations } from '../../server/src/modules/citations/validate.js';
import { withRetry } from '../../server/src/utils/retry.js';
import { withAvailableModel } from '../../server/src/infrastructure/llm/gemini.js';

describe('intent routing', () => {
  it('routes history-only questions to memory without search', () => expect(routeIntent('What did I ask you last week?')).toMatchObject({ memory: true, web: false }));
  it('routes historical comparisons to both tools', () => expect(routeIntent('Has the pricing changed since last week?')).toMatchObject({ memory: true, web: true }));
  it('routes current pricing to search only', () => expect(routeIntent('What is current pricing?')).toMatchObject({ memory: false, web: true }));
  it('keeps general chat local', () => expect(routeIntent('Explain how a database index works')).toMatchObject({ memory: false, web: false }));
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
