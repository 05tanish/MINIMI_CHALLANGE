const startedAt = Date.now();
const http = { count: 0, errors: 0, durationMs: 0, byStatus: {} };
const providers = new Map();
const jobs = { completed: 0, failed: 0 };

export function observeHttp(status, durationMs) {
  http.count += 1; http.durationMs += durationMs;
  if (status >= 500) http.errors += 1;
  http.byStatus[status] = (http.byStatus[status] ?? 0) + 1;
}

export function observeProvider(provider, model, status, durationMs, usage = {}) {
  const key = `${provider}:${model}:${status}`;
  const value = providers.get(key) ?? { count: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 };
  value.count += 1; value.durationMs += durationMs;
  value.inputTokens += Number(usage.inputTokens ?? 0);
  value.outputTokens += Number(usage.outputTokens ?? 0);
  providers.set(key, value);
}

export function observeJob(status) {
  if (status === 'completed') jobs.completed += 1;
  if (status === 'failed') jobs.failed += 1;
}

export function getMetrics() {
  return { uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), http: { ...http, averageDurationMs: http.count ? Math.round(http.durationMs / http.count) : 0 }, providers: Object.fromEntries(providers), jobs: { ...jobs } };
}
