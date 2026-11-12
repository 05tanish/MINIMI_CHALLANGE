import { afterEach, describe, expect, it, vi } from 'vitest';
process.env.TAVILY_API_KEY = 'test-key';
const { searchQueries } = await import('../../server/src/infrastructure/search/tavily.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('Tavily normalization', () => {
  it('deduplicates URLs and preserves successful results when another query fails', async () => {
    globalThis.fetch = vi.fn(async (_url, options) => {
      const { query } = JSON.parse(options.body);
      if (query === 'broken') return new Response(JSON.stringify({ error: 'invalid query' }), { status: 400 });
      return new Response(JSON.stringify({ results: [
        { title: 'Pricing', url: 'https://example.com/pricing#plans', content: 'Official plan details', published_date: '2026-10-01' },
        { title: 'Duplicate', url: 'https://example.com/pricing', content: 'Same page' },
        { title: 'Unsafe', url: 'javascript:alert(1)', content: 'ignore' }
      ] }), { status: 200 });
    });
    const result = await searchQueries(['pricing', 'broken'], new AbortController().signal);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ title: 'Pricing', publishedAt: '2026-10-01' });
    expect(result.sources[0].retrievedAt).toBeTruthy();
    expect(result.failures).toEqual([{ query: 'broken', error: 'SEARCH_FAILED' }]);
  });
});
