const ENTITY_PATTERNS = [
  ['technology', /\b(PostgreSQL|Postgres|Neon|Supabase|Prisma|AWS|Vercel|Render)\b/gi],
  ['product', /\b(Salesforce|HubSpot|Pipedrive|Zoho CRM|Attio|Close)\b/gi],
  ['price', /(?:[$€£₹]\s?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:USD|EUR|INR)\b)/gi]
];
export function extractEntities(text) {
  const found = new Map();
  for (const [type, regex] of ENTITY_PATTERNS) for (const match of text.matchAll(regex)) found.set(match[0].toLowerCase(), { name: match[0], type });
  return [...found.values()];
}
export function makeTopicChunks(messages, indexedEntities = {}) {
  const groups = [];
  for (const message of messages) {
    const entities = [...extractEntities(message.content), ...(indexedEntities[message.id] ?? [])];
    const key = entities.map((e) => e.name.toLowerCase()).sort().join('|') || message.content.toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    const group = groups.at(-1);
    const overlap = group && entities.some((entity) => group.entityNames.has(entity.name.toLowerCase()));
    if (group && (group.key === key || overlap)) { group.messages.push(message); group.endAt = message.createdAt; for (const entity of entities) { group.entityNames.add(entity.name.toLowerCase()); if (!group.entities.some((old) => old.name.toLowerCase() === entity.name.toLowerCase())) group.entities.push(entity); } }
    else groups.push({ key, messages: [message], startAt: message.createdAt, endAt: message.createdAt, entities, entityNames: new Set(entities.map((e) => e.name.toLowerCase())) });
  }
  return groups.map((g) => ({ content: g.messages.map((m) => `${m.role}: ${m.content}`).join('\n'), topic: g.entities.map((e) => e.name).join(', ') || 'Conversation', entities: g.entities, startAt: g.startAt, endAt: g.endAt, messageIds: g.messages.map((m) => m.id) }));
}
