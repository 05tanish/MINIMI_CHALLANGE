export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'DATABASE_UNAVAILABLE' ? 503 : error.code === 'LLM_UNAVAILABLE' ? 503 : error.code === 'LLM_RATE_LIMITED' ? 429 : error.code === 'RESEARCH_TIMEOUT' ? 504 : 500;
  req.log?.error({ err: error, code: error.code ?? 'INTERNAL_ERROR', status }, 'Request failed');
  res.status(status).json({ success: false, data: null, error: { code: error.code ?? 'INTERNAL_ERROR', message: status === 500 ? 'An unexpected error occurred.' : error.message } });
}
