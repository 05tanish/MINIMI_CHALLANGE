/**
 * Content extraction: fetches and converts web pages to text for deeper analysis.
 * Search snippets are too shallow for pricing comparisons; this reads the real page.
 */

import { logger } from '../logging/logger.js';
import { truncateToTokens } from '../../utils/tokens.js';
import { env } from '../../config/env.js';

/**
 * Fetch a URL and extract main text content from HTML.
 * Strips scripts, styles, navigation, headers, footers, and HTML tags.
 */
async function fetchPageText(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; MinimiResearchBot/1.0)', accept: 'text/html' },
    redirect: 'follow'
  });
  if (!response.ok) throw Object.assign(new Error(`Page fetch returned ${response.status}`), { code: 'EXTRACT_FAILED', status: response.status });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) throw Object.assign(new Error('Unsupported content type'), { code: 'EXTRACT_FAILED' });
  const html = await response.text();
  return htmlToText(html);
}

/**
 * Convert HTML to plain text by removing non-content elements and tags.
 * Not a full parser — sufficient for extracting readable text from pricing pages and release notes.
 */
function htmlToText(html) {
  return html
    // Remove non-content blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    // Convert block elements to newlines for readability
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Enrich search results with extracted page content.
 * Only fetches the top N most relevant results to stay within latency budget.
 * Results that already have rawContent (from Tavily) are used as-is.
 */
export async function enrichWithContent(sources, { maxExtractions = env.MAX_CONTENT_EXTRACTIONS, tokenBudget = env.CONTENT_TOKEN_BUDGET, signal } = {}) {
  const top = sources.slice(0, maxExtractions);
  const results = await Promise.allSettled(
    top.map(async (source) => {
      // Skip already-enriched sources (from a previous research round)
      if (source.extractedContent) return source;
      // Use pre-fetched raw content if available (Tavily include_raw_content)
      if (source.rawContent) {
        return { ...source, extractedContent: truncateToTokens(source.rawContent, tokenBudget) };
      }
      // Otherwise fetch the page ourselves
      const content = await fetchPageText(source.url, signal);
      return { ...source, extractedContent: truncateToTokens(content, tokenBudget) };
    })
  );

  return sources.map((source, i) => {
    if (i < maxExtractions && results[i].status === 'fulfilled') {
      return results[i].value;
    }
    return source;
  });
}

/**
 * Format source text for LLM context, including extracted content when available.
 */
export function formatSourceForLLM(source) {
  const parts = [`[${source.id}] ${source.title}`];
  if (source.snippet) parts.push(source.snippet);
  if (source.extractedContent) parts.push(`--- Full page content ---\n${source.extractedContent}`);
  if (source.url) parts.push(`URL: ${source.url}`);
  if (source.publishedAt) parts.push(`Published: ${source.publishedAt}`);
  return parts.join('\n');
}
