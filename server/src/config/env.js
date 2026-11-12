import 'dotenv/config';
import { z } from 'zod';

const environmentName = (process.env.NODE_ENV ?? 'development').toUpperCase();
if (!process.env.DATABASE_URL?.trim()) process.env.DATABASE_URL = process.env[`DATABASE_URL_${environmentName}`] ?? '';
if (!process.env.GEMINI_API_KEY?.trim()) process.env.GEMINI_API_KEY = process.env[`GEMINI_API_KEY_${environmentName}`] ?? '';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_FALLBACK_MODELS: z.string().default('gemini-3.6-flash,gemini-3.7-flash'),
  GEMINI_THINKING_LEVEL: z.enum(['low', 'medium', 'high']).default('low'),
  GEMINI_MODEL_TIMEOUT_MS: z.coerce.number().default(10000),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-2'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().default(768),
  TAVILY_API_KEY: z.string().optional(),
  USER_TIMEZONE: z.string().default('Asia/Kolkata'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(30),
  SEARCH_TIMEOUT_MS: z.coerce.number().default(12000),
  LLM_TIMEOUT_MS: z.coerce.number().default(30000),
  RESEARCH_BUDGET_MS: z.coerce.number().default(45000),
  MAX_SEARCH_QUERIES: z.coerce.number().default(4),
  MAX_CONTEXT_CHUNKS: z.coerce.number().default(8),
  MAX_REQUEST_BYTES: z.string().default('64kb')
});

export const env = schema.parse(process.env);
