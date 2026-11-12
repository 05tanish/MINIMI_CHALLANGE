/**
 * Temporal diff engine: compares structured claims from memory (historical)
 * against claims from web search (current) to produce an explicit "what changed" report.
 *
 * Instead of asking the LLM to implicitly compare free-text, we match claims
 * by normalized entity + attribute and flag changes, making the comparison
 * auditable and verifiable.
 */

import { normalizeEntity } from '../claims/extract.js';

/**
 * Match claims by entity + attribute across two sets.
 * Uses fuzzy entity matching: "HubSpot" matches "HubSpot CRM" after normalization.
 */
function matchClaims(historical, current) {
  const matches = [];
  const usedCurrent = new Set();

  for (const histClaim of historical) {
    const histEntity = normalizeEntity(histClaim.entity);
    const histAttr = histClaim.attribute;

    // Find best matching current claim
    let bestMatch = null;
    let bestScore = 0;
    for (let i = 0; i < current.length; i++) {
      if (usedCurrent.has(i)) continue;
      const curr = current[i];
      const currEntity = normalizeEntity(curr.entity);
      let score = 0;
      if (histEntity === currEntity) score += 2;
      else if (histEntity.includes(currEntity) || currEntity.includes(histEntity)) score += 1;
      if (histAttr === curr.attribute) score += 1;
      if (score > bestScore) { bestScore = score; bestMatch = { claim: curr, index: i }; }
    }

    if (bestMatch && bestScore >= 2) {
      usedCurrent.add(bestMatch.index);
      matches.push({ historical: histClaim, current: bestMatch.claim, score: bestScore });
    } else {
      matches.push({ historical: histClaim, current: null, score: 0 });
    }
  }

  // Unmatched current claims
  const unmatchedCurrent = current.filter((_, i) => !usedCurrent.has(i));
  return { matches, unmatchedCurrent };
}

/**
 * Determine if two claim values represent a change.
 * Handles common variations: "$20/mo" vs "$20/month", "20 USD" vs "$20".
 */
function isSameValue(a, b) {
  const norm = (v) => v.toLowerCase().replace(/[$€£₹]/g, '').replace(/\s+/g, '').replace(/\/month/g, '/mo').replace(/\/year/g, '/yr').replace(/usd|eur|inr/g, '').trim();
  return norm(a) === norm(b);
}

/**
 * Run the temporal diff between historical (memory) and current (web) claims.
 * Returns structured comparison entries suitable for LLM context and UI display.
 */
export function diffClaims(memoryClaims, webClaims) {
  if (!memoryClaims?.length && !webClaims?.length) return { entries: [], summary: null };
  if (!memoryClaims?.length) return { entries: [], summary: 'No historical claims found to compare.' };
  if (!webClaims?.length) return { entries: [], summary: 'No current web evidence found to compare.' };

  const { matches, unmatchedCurrent } = matchClaims(memoryClaims, webClaims);

  const entries = [];
  for (const { historical, current } of matches) {
    if (!current) {
      entries.push({
        entity: historical.entity,
        attribute: historical.attribute,
        historicalValue: historical.value,
        historicalDate: historical.date,
        currentValue: null,
        currentSource: null,
        status: 'no_current_evidence'
      });
    } else if (isSameValue(historical.value, current.value)) {
      entries.push({
        entity: historical.entity,
        attribute: historical.attribute,
        historicalValue: historical.value,
        historicalDate: historical.date,
        currentValue: current.value,
        currentSource: current.source,
        status: 'unchanged'
      });
    } else {
      entries.push({
        entity: historical.entity,
        attribute: historical.attribute,
        historicalValue: historical.value,
        historicalDate: historical.date,
        currentValue: current.value,
        currentSource: current.source,
        status: 'changed'
      });
    }
  }

  for (const claim of unmatchedCurrent) {
    entries.push({
      entity: claim.entity,
      attribute: claim.attribute,
      historicalValue: null,
      historicalDate: null,
      currentValue: claim.value,
      currentSource: claim.source,
      status: 'new_finding'
    });
  }

  const changed = entries.filter((e) => e.status === 'changed');
  const unchanged = entries.filter((e) => e.status === 'unchanged');
  const newFindings = entries.filter((e) => e.status === 'new_finding');
  const noEvidence = entries.filter((e) => e.status === 'no_current_evidence');

  const summary = `Comparison complete: ${changed.length} changed, ${unchanged.length} unchanged, ${newFindings.length} new findings, ${noEvidence.length} without current evidence.`;

  return { entries, summary, stats: { changed: changed.length, unchanged: unchanged.length, newFindings: newFindings.length, noEvidence: noEvidence.length } };
}

/**
 * Format the diff result as structured text for the LLM prompt.
 * This gives the LLM an explicit comparison to write from, rather than
 * asking it to figure out the diff from raw text.
 */
export function formatDiffForLLM(diff) {
  if (!diff?.entries?.length) return '(No structured comparison available — compare memory and sources directly.)';

  const lines = ['STRUCTURED COMPARISON (historical memory vs current web evidence):', ''];

  for (const entry of diff.entries) {
    const statusLabel = {
      changed: '⚠ CHANGED',
      unchanged: '✓ UNCHANGED',
      new_finding: '★ NEW',
      no_current_evidence: '? NO CURRENT EVIDENCE'
    }[entry.status] ?? entry.status;

    if (entry.historicalValue && entry.currentValue) {
      lines.push(`${statusLabel}: ${entry.entity} — ${entry.attribute}`);
      lines.push(`  Historical (${entry.historicalDate ?? 'date unknown'}): ${entry.historicalValue}`);
      lines.push(`  Current: ${entry.currentValue}`);
    } else if (entry.currentValue) {
      lines.push(`${statusLabel}: ${entry.entity} — ${entry.attribute}: ${entry.currentValue}`);
    } else {
      lines.push(`${statusLabel}: ${entry.entity} — ${entry.attribute}: ${entry.historicalValue} (historical, no current evidence)`);
    }
    lines.push('');
  }

  if (diff.summary) lines.push(`Summary: ${diff.summary}`);

  return lines.join('\n');
}
