/**
 * Self-verification: checks that claims in the generated answer are actually
 * supported by the cited source text. Goes beyond citation ID validation —
 * verifies claim content against source content.
 */

import { logger } from '../../infrastructure/logging/logger.js';

/**
 * Extract (claim text, citation ID) pairs from the answer.
 * Looks for patterns like "HubSpot is now $25/mo [S1]" and groups text
 * before each citation as the associated claim.
 */
export function extractClaimCitationPairs(text) {
  const pairs = [];
  // Split by citation markers, keeping the citation
  const parts = text.split(/(\[S\d+\])/);
  let currentClaim = '';

  for (const part of parts) {
    const citeMatch = part.match(/\[S(\d+)\]/);
    if (citeMatch) {
      // Take the last ~200 chars of the preceding text as the claim
      const claimText = currentClaim.trim().slice(-300);
      if (claimText) {
        pairs.push({ claim: claimText, citationId: `S${citeMatch[1]}` });
      }
      currentClaim = '';
    } else {
      currentClaim += part;
    }
  }

  return pairs;
}

/**
 * Check if a source's text (snippet + extracted content) supports a claim.
 * Uses keyword overlap as a lightweight heuristic. Not perfect, but catches
 * the most common hallucination pattern: citing a real source for a fabricated fact.
 */
function checkSupport(claim, source) {
  const sourceText = [source.snippet ?? '', source.extractedContent ?? '', source.title ?? '']
    .join(' ')
    .toLowerCase();

  if (!sourceText || sourceText.length < 10) return { supported: false, reason: 'source text too short' };

  // Extract key terms from the claim (words > 3 chars, excluding common words)
  const stopWords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been', 'will', 'was', 'are', 'not', 'but', 'has', 'had', 'its', 'all', 'can', 'may', 'also', 'would', 'could', 'should', 'about', 'into', 'than', 'them', 'they', 'were', 'your', 'their']);
  const claimWords = claim.toLowerCase()
    .replace(/[^\w\s$€£₹]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  if (claimWords.length === 0) return { supported: true, reason: 'no checkable terms' };

  // Check how many claim keywords appear in the source text
  const matched = claimWords.filter((w) => sourceText.includes(w));
  const overlap = matched.length / claimWords.length;

  // Also check for price/number patterns
  const claimPrices = claim.match(/[$€£₹]\s?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:USD|EUR|INR)\b/gi) ?? [];
  const sourcePrices = sourceText.match(/[$€£₹]\s?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:USD|EUR|INR)\b/gi) ?? [];
  const priceMatch = claimPrices.every((p) => sourcePrices.some((sp) => sp.replace(/\s/g, '').includes(p.replace(/\s/g, ''))));

  if (claimPrices.length > 0 && !priceMatch) {
    return { supported: false, reason: 'price in claim not found in source' };
  }

  return { supported: overlap >= 0.3, reason: `${Math.round(overlap * 100)}% keyword overlap` };
}

/**
 * Verify all claim-citation pairs in the answer against the provided sources.
 * Returns a list of verification results, including any unsupported claims.
 */
export function verifyClaims(answer, sources) {
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const pairs = extractClaimCitationPairs(answer);

  const results = pairs.map((pair) => {
    const source = sourceMap.get(pair.citationId);
    if (!source) return { ...pair, supported: false, reason: 'citation does not match any source' };
    const check = checkSupport(pair.claim, source);
    return { ...pair, supported: check.supported, reason: check.reason };
  });

  const unsupported = results.filter((r) => !r.supported);
  const supported = results.filter((r) => r.supported);

  return {
    verified: unsupported.length === 0,
    total: results.length,
    supportedCount: supported.length,
    unsupportedCount: unsupported.length,
    unsupported,
    results
  };
}

/**
 * Generate a user-facing notice for unsupported claims.
 * Appended to the answer when verification finds issues.
 */
export function verificationNotice(verification) {
  if (verification.verified || verification.unsupportedCount === 0) return null;
  const count = verification.unsupportedCount;
  return `⚠ ${count} claim${count > 1 ? 's' : ''} in this answer could not be verified against the cited source${count > 1 ? 's' : ''}. Please double-check before relying on this information.`;
}
