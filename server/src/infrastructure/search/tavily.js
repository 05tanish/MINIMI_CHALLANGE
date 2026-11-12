import { env } from '../../config/env.js';
import { logger } from '../logging/logger.js';
import { withRetry } from '../../utils/retry.js';
export async function searchWeb(query, signal) {
  if (!env.TAVILY_API_KEY) throw Object.assign(new Error('Web search is not configured'), { code: 'SEARCH_NOT_CONFIGURED' });
  const response = await withRetry(async () => {
    const result = await fetch('https://api.tavily.com/search', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, search_depth: env.SEARCH_DEPTH, max_results: 5, include_answer: false, include_raw_content: true }) });
    if (!result.ok) {
      const error = Object.assign(new Error(`Search provider returned ${result.status}`), { code: 'SEARCH_FAILED', status: result.status, retryAfter: result.headers.get('retry-after') });
      if (result.status < 500 && result.status !== 429) error.noRetry = true;
      throw error;
    }
    return result;
  }, { retries: 2, signal, shouldRetry: (error) => !error.noRetry && (error.status === 429 || error.status >= 500 || error.name === 'TypeError') });
  const body = await response.json(); const retrievedAt = new Date().toISOString();
  return (body.results ?? []).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? '', rawContent: r.raw_content ?? null, publishedAt: r.published_date ?? null, retrievedAt }));
}
export async function searchQueries(queries, signal) {
  const startedAt = Date.now();
  const settled = await Promise.allSettled(queries.map((q) => searchWeb(q, signal)));
  const results = []; const failures = [];
  settled.forEach((item, i) => item.status === 'fulfilled' ? results.push(...item.value) : failures.push({ query: queries[i], error: item.reason?.code ?? 'SEARCH_FAILED' }));
  const seen = new Set(); const unique = results.filter((r) => { try { const u = new URL(r.url); if (u.protocol !== 'https:' && u.protocol !== 'http:') return false; u.hash = ''; const key = u.toString().replace(/\/$/, ''); if (seen.has(key)) return false; seen.add(key); return true; } catch { logger.warn('Ignoring invalid search result URL'); return false; } });
  logger.info({ queryCount: queries.length, resultCount: unique.length, failureCount: failures.length, durationMs: Date.now() - startedAt }, 'Web research completed');
  return { sources: unique, failures };
}
