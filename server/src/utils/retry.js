export async function withRetry(operation, { retries = 1, baseDelayMs = 250, maxDelayMs = 2500, shouldRetry = () => true, signal } = {}) {
  let attempt = 0;
  while (true) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt >= retries || !shouldRetry(error) || signal?.aborted) throw error;
      const retryAfter = parseRetryAfter(error.retryAfter);
      const jitter = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(done, Math.max(retryAfter, jitter));
        function done() { signal?.removeEventListener('abort', abort); resolve(); }
        function abort() { clearTimeout(timer); reject(signal.reason ?? new Error('Operation aborted')); }
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      attempt += 1;
    }
  }
}

function parseRetryAfter(value) {
  if (value == null) return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Math.max(0, Math.min(30_000, Number.isFinite(milliseconds) ? milliseconds : 0));
}
