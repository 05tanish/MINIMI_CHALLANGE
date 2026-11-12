/**
 * Content extraction: fetches and converts web pages to text for deeper analysis.
 * Search snippets are too shallow for pricing comparisons; this reads the real page.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { logger } from '../logging/logger.js';
import { truncateToTokens } from '../../utils/tokens.js';
import { env } from '../../config/env.js';

/**
 * Fetch a URL and extract main text content from HTML.
 * Strips scripts, styles, navigation, headers, footers, and HTML tags.
 */
const blockedAddresses = new BlockList();
for (const subnet of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']) blockedAddresses.addSubnet(subnet.split('/')[0], Number(subnet.split('/')[1]), 'ipv4');
for (const subnet of ['::/128', '::1/128', '::ffff:0:0/96', '64:ff9b:1::/48', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8']) blockedAddresses.addSubnet(subnet.split('/')[0], Number(subnet.split('/')[1]), 'ipv6');
const maxPageBytes = 2 * 1024 * 1024;

export async function assertPublicHttpUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw Object.assign(new Error('Invalid source URL'), { code: 'EXTRACT_FAILED' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw Object.assign(new Error('Unsupported source URL'), { code: 'EXTRACT_FAILED' });
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => blockedAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4'))) throw Object.assign(new Error('Source host resolves to a non-public address'), { code: 'EXTRACT_BLOCKED' });
  return url;
}

async function readLimited(response) {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxPageBytes) throw Object.assign(new Error('Source page exceeds the extraction size limit'), { code: 'EXTRACT_TOO_LARGE' });
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxPageBytes) { await reader.cancel(); throw Object.assign(new Error('Source page exceeds the extraction size limit'), { code: 'EXTRACT_TOO_LARGE' }); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchPageText(input, signal) {
  let url = await assertPublicHttpUrl(input);
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  let response;
  for (let redirect = 0; redirect <= 3; redirect++) {
    response = await fetch(url, { signal: fetchSignal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; MinimiResearchBot/1.0)', accept: 'text/html,text/plain' }, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirect === 3) throw Object.assign(new Error('Source page has too many or invalid redirects'), { code: 'EXTRACT_FAILED' });
    url = await assertPublicHttpUrl(new URL(location, url).toString());
  }
  if (!response.ok) throw Object.assign(new Error(`Page fetch returned ${response.status}`), { code: 'EXTRACT_FAILED', status: response.status });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) throw Object.assign(new Error('Unsupported content type'), { code: 'EXTRACT_FAILED' });
  return htmlToText(await readLimited(response));
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
