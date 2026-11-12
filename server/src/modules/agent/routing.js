const MEMORY = /\b(remember|previous|earlier|last (?:week|month|monday|tuesday|time)|on \d{1,2} [a-z]+|what did i ask|our (?:decision|discussion)|changed since)\b/i;
const WEB = /\b(current|currently|today|latest|newest|price|pricing|changed|shipped|release|recent|now)\b/i;
export function routeIntent(text) {
  const memory = MEMORY.test(text);
  const web = WEB.test(text);
  return { memory, web, intent: memory && web ? 'historical_current_comparison' : memory ? 'historical_retrieval' : web ? 'current_research' : 'conversation' };
}
