export function validateCitations(text, sources) {
  const ids = new Set(sources.map((s) => s.id));
  const refs = [...text.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
  return { valid: refs.every((id) => ids.has(id)), references: [...new Set(refs)], invalid: [...new Set(refs.filter((id) => !ids.has(id)))] };
}
