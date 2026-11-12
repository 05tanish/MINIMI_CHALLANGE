/**
 * Structured claim extraction: converts free-text evidence into comparable facts.
 * Extracts claims like { entity: "HubSpot", attribute: "price", value: "$20/mo", date: "2026-11-03" }
 * from both conversation memory and web search results.
 */

import { logger } from '../../infrastructure/logging/logger.js';

const PRICE_REGEX = /(?:[$€£₹]\s?\d+(?:\.\d+)?(?:\s?\/\s?(?:mo|month|user|seat|yr|year))?|\b\d+(?:\.\d+)?\s?(?:USD|EUR|INR)\b(?:\s?\/\s?(?:mo|month))?)/gi;
const ENTITY_REGEX = /\b(PostgreSQL|Postgres|Neon|Supabase|Prisma|AWS|Vercel|Render|Salesforce|HubSpot|Pipedrive|Zoho CRM|Attio|Close|GitHub Copilot|Stripe|Notion|Linear|Figma|Slack)\b/gi;

/** Normalize entity names for matching: lowercase, trim, remove common suffixes. */
export function normalizeEntity(name) {
  let result = name.toLowerCase().trim();
  let prev;
  do {
    prev = result;
    result = result.replace(/\s+(crm|tool|platform|service|database|hosting)$/i, '');
  } while (result !== prev);
  return result;
}

/** Fast regex-based claim extraction as fallback when LLM is unavailable. */
export function extractClaimsFast(text) {
  if (!text) return [];
  const claims = [];
  const entities = new Map();
  for (const match of text.matchAll(ENTITY_REGEX)) {
    const key = match[0].toLowerCase();
    if (!entities.has(key)) entities.set(key, match[0]);
  }
  for (const [entityKey, entityName] of entities) {
    const priceMatches = text.matchAll(new RegExp(entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*?(' + PRICE_REGEX.source + ')', 'gi'));
    for (const pm of priceMatches) {
      claims.push({ entity: entityName, attribute: 'price', value: pm[1].trim(), date: null });
    }
  }
  // Standalone prices without a clear entity
  for (const match of text.matchAll(PRICE_REGEX)) {
    claims.push({ entity: '(unknown)', attribute: 'price', value: match[0].trim(), date: null });
  }
  return claims;
}

/**
 * LLM-based claim extraction for higher accuracy.
 * Asks the LLM to return structured JSON claims from the given text.
 */
export async function extractClaimsWithLLM(text, contextType, geminiModule, signal) {
  if (!text || text.length < 10) return [];
  const { withAvailableModel, ai, env, thinkingConfigFor } = geminiModule;
  if (!ai) return extractClaimsFast(text);

  const contextLabel = contextType === 'memory' ? 'past conversation history' : 'current web search results';
  const prompt = `Extract verifiable factual claims from the following ${contextLabel}. Return a JSON array where each claim is {"entity": string, "attribute": "price"|"feature"|"plan"|"release"|"limit"|"other", "value": string, "date": "YYYY-MM-DD" or null}. Focus on prices, plan names, feature lists, version numbers, release dates, and usage limits. Only extract claims that are explicitly stated in the text. Do not infer or fabricate.

TEXT:
${text}

Return JSON array only:`;

  try {
    const { result: response } = await withAvailableModel(
      (model, modelSignal) => ai.models.generateContent({
        model,
        contents: prompt,
        config: { abortSignal: modelSignal, responseMimeType: 'application/json', maxOutputTokens: 800, ...thinkingConfigFor(model) }
      }),
      signal
    );
    const parsed = JSON.parse(response.text ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => c && typeof c.entity === 'string' && typeof c.value === 'string')
      .map((c) => ({
        entity: c.entity.slice(0, 100),
        attribute: ['price','feature','plan','release','limit','other'].includes(c.attribute) ? c.attribute : 'other',
        value: c.value.slice(0, 300),
        date: c.date ?? null,
        source: contextType
      }));
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.warn({ code: error.code ?? error.name }, 'LLM claim extraction failed; using regex fallback');
    return extractClaimsFast(text);
  }
}

/**
 * Extract claims from memory chunks and web sources in parallel.
 */
export async function extractAllClaims({ memoryChunks, webSources, geminiModule, signal }) {
  const memoryBatches = await Promise.all(memoryChunks.map(async (chunk) => {
    const claims = await extractClaimsWithLLM(chunk.content, 'memory', geminiModule, signal).catch(() => extractClaimsFast(chunk.content));
    return claims.map((claim) => ({ ...claim, conversationId: chunk.conversationId, messageId: chunk.metadata?.messageIds?.at(-1) ?? null }));
  }));
  const webBatches = await Promise.all(webSources.map(async (source) => {
    const text = [source.snippet, source.extractedContent].filter(Boolean).join('\n');
    const claims = await extractClaimsWithLLM(text, 'web', geminiModule, signal).catch(() => extractClaimsFast(text));
    return claims.map((claim) => ({ ...claim, sourceUrl: source.url }));
  }));
  return { memoryClaims: memoryBatches.flat(), webClaims: webBatches.flat() };
}
