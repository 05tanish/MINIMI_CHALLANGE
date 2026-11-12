export async function withRetry(operation, { retries = 1, baseDelayMs = 250, maxDelayMs = 2500, shouldRetry = () => true, signal } = {}) {
  let attempt = 0;
  while (true) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt >= retries || !shouldRetry(error) || signal?.aborted) throw error;
      const retryAfter = Number(error.retryAfter ?? 0) * 1000;
      const jitter = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, Math.max(retryAfter, jitter));
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      attempt += 1;
    }
  }
}
