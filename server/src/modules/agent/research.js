/**
 * Agentic research loop: iteratively searches, evaluates coverage, and refines.
 *
 * Instead of a single batch of search queries, the agent:
 *   Round 1: Search with initial queries → evaluate coverage
 *   Round 2: If gaps found, search with refined queries → re-evaluate
 *   Synthesize from all collected sources
 *
 * Bounded by MAX_SEARCH_ROUNDS and the overall RESEARCH_BUDGET_MS to prevent
 * unbounded spiraling. Each round adds queries for entities the LLM coverage
 * evaluation identified as missing.
 */

import { searchQueries } from '../../infrastructure/search/tavily.js';
import { enrichWithContent } from '../../infrastructure/search/extract.js';
import { evaluateCoverage } from '../../infrastructure/llm/gemini.js';
import { env } from '../../config/env.js';
import { logger } from '../../infrastructure/logging/logger.js';

/**
 * Generate search queries from the user message, LLM analysis, and memory entities.
 * Memory-informed queries are the key to adaptive search: if the user discussed
 * 5 CRM tools last Monday, we search for each of those 5 tools specifically.
 */
export function planSearchQueries(message, analysis, memoryChunks) {
  const entities = [...(analysis.entities ?? [])];
  // Extract entity names from memory chunks for adaptive queries
  for (const chunk of memoryChunks) {
    if (chunk.entities) {
      for (const entity of chunk.entities) {
        if (!entities.some((e) => e.name.toLowerCase() === entity.name?.toLowerCase())) {
          entities.push({ name: entity.name, type: entity.type ?? 'memory' });
        }
      }
    }
  }

  const queries = new Set();
  // Preserve the user's actual question and planner queries before adding
  // entity expansions. Otherwise generic entity templates can crowd out the
  // question and return irrelevant pricing or release pages.
  queries.add(message);
  for (const q of analysis.searchQueries ?? []) queries.add(q);
  for (const entity of entities.slice(0, 4)) {
    queries.add(`${entity.name} ${message}`);
  }

  return [...queries].slice(0, env.MAX_SEARCH_QUERIES);
}

/**
 * Run the bounded agentic research loop.
 *
 * @param {string[]} initialQueries - Search queries planned from message + memory
 * @param {Array} entities - Entities to track for coverage evaluation
 * @param {string} message - Original user message (for coverage evaluation context)
 * @param {object} options - signal, onProgress callback
 * @returns {Promise<{ sources: Array, failures: Array, rounds: number }>}
 */
export async function researchLoop(initialQueries, entities, message, { signal, onProgress } = {}) {
  const maxRounds = env.MAX_SEARCH_ROUNDS;
  let allSources = [];
  let allFailures = [];
  let queries = initialQueries;
  let rounds = 0;
  const searchedQueries = new Set();

  for (let round = 1; round <= maxRounds; round++) {
    // Filter out already-searched queries
    const newQueries = queries.filter((q) => !searchedQueries.has(q));
    if (newQueries.length === 0) break;
    newQueries.forEach((q) => searchedQueries.add(q));

    rounds = round;
    onProgress?.({ round, queryCount: newQueries.length, phase: 'searching' });

    // Search this round's queries
    const searchSignal = signal ?? new AbortController().signal;
    const search = await searchQueries(newQueries, searchSignal);
    allSources.push(...search.sources);
    allFailures.push(...search.failures);

    // Enrich top results with extracted page content
    allSources = await enrichWithContent(allSources, { signal: searchSignal });

    onProgress?.({ round, sourceCount: allSources.length, phase: 'content_extracted' });

    // Don't evaluate coverage on the last allowed round — just use what we have
    if (round >= maxRounds) break;

    // Evaluate coverage: does the LLM think we have enough evidence?
    const coverage = await evaluateCoverage({
      query: message,
      entities,
      sources: allSources.slice(0, 15).map((s, i) => ({ id: `S${i + 1}`, title: s.title })),
      signal: searchSignal
    });

    onProgress?.({ round, sufficient: coverage.sufficient, missing: coverage.missingEntities, phase: 'evaluated' });

    if (coverage.sufficient) {
      logger.info({ round, sufficient: true }, 'Research coverage sufficient; stopping early');
      break;
    }

    // Generate refined queries for missing entities
    if (coverage.suggestedQueries.length > 0) {
      queries = coverage.suggestedQueries.slice(0, env.MAX_SEARCH_QUERIES);
    } else if (coverage.missingEntities.length > 0) {
      queries = coverage.missingEntities.map((e) => `${e} pricing latest 2026`).slice(0, env.MAX_SEARCH_QUERIES);
    } else {
      break;
    }

    logger.info({ round, sufficient: false, missingEntities: coverage.missingEntities, nextQueries: queries.length }, 'Research coverage insufficient; searching again');
  }

  // Deduplicate final source list by URL
  const seen = new Set();
  const deduped = allSources.filter((s) => {
    try { const key = new URL(s.url).toString().replace(/\/$/, ''); if (seen.has(key)) return false; seen.add(key); return true; } catch { return false; }
  });

  logger.info({ rounds, totalSources: deduped.length, failures: allFailures.length }, 'Research loop complete');

  return { sources: deduped, failures: allFailures, rounds };
}
