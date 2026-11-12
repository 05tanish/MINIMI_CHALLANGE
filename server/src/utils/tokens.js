/**
 * Lightweight token estimation and truncation.
 * Uses the standard approximation of ~4 characters per token for English text.
 * Not exact, but sufficient for budget management before LLM calls.
 */

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  // Truncate at word boundary to avoid cutting mid-word
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.8 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

export function estimateContentTokens(items, field = 'content') {
  return items.reduce((sum, item) => sum + estimateTokens(item[field] ?? ''), 0);
}
