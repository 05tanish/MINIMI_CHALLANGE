import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../server/src/app.js';

describe('HTTP API', () => {
  it('validates chat requests before streaming', async () => {
    const response = await request(app).post('/api/chat').send({ message: '' });
    expect(response.status).toBe(400); expect(response.body.error.code).toBe('INVALID_REQUEST');
  });
  it('requires an idempotency key for accepted chat turns', async () => {
    const response = await request(app).post('/api/chat').send({ message: 'Explain relational databases.' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
  it('rejects weak signup credentials before accessing the database', async () => {
    const response = await request(app).post('/api/auth/signup').send({ email: 'not-an-email', password: 'short' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });
  it('reports application health and dependency readiness separately', async () => {
    const response = await request(app).get('/api/health');
    expect([200, 503]).toContain(response.status); expect(response.body.data.application).toBe('ready');
  });
  it('returns a controlled error for database-dependent routes when unavailable', async () => {
    const response = await request(app).get('/api/conversations');
    if (process.env.DATABASE_URL) expect(response.status).toBe(200);
    else { expect(response.status).toBe(503); expect(response.body.error.code).toBe('DATABASE_UNAVAILABLE'); }
  });
});
