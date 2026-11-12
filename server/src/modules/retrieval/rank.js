export function reciprocalRankFusion(lists, k = 60) {
  const scores = new Map(); const docs = new Map();
  for (const list of lists) list.forEach((doc, index) => {
    const id = doc.id ?? doc.url ?? doc.content;
    docs.set(id, doc); scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
  });
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ ...docs.get(id), rrfScore: score }));
}
