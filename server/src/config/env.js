import 'dotenv/config';
import { z } from 'zod';

const environmentName = (process.env.NODE_ENV ?? 'development').toUpperCase();
if (!process.env.DATABASE_URL?.trim()) process.env.DATABASE_URL = process.env[`DATABASE_URL_${environmentName}`] ?? '';
if (!process.env.GEMINI_API_KEY?.trim()) process.env.GEMINI_API_KEY = process.env[`GEMINI_API_KEY_${environmentName}`] ?? '';
if (!process.env.GROQ_API_KEY?.trim()) process.env.GROQ_API_KEY = process.env[`GROQ_API_KEY_${environmentName}`] ?? '';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().optional(),
  SESSION_COOKIE_NAME: z.string().default('minimi_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  TRUST_PROXY: z.string().default('false').transform((value) => value === 'true'),
  REDIS_REST_URL: z.string().url().or(z.literal('')).optional(),
  REDIS_REST_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  LLM_PROVIDER_COOLDOWN_MS: z.coerce.number().int().min(1000).default(60000),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
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
  MAX_SEARCH_ROUNDS: z.coerce.number().int().min(1).max(5).default(2),
  MAX_CONTENT_EXTRACTIONS: z.coerce.number().int().default(3),
  CONTENT_TOKEN_BUDGET: z.coerce.number().int().default(2000),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().default(2048),
  VERIFY_CLAIMS: z.coerce.boolean().default(true),
  SEARCH_DEPTH: z.enum(['basic', 'advanced']).default('basic'),
  MAX_CONTEXT_CHUNKS: z.coerce.number().default(8),
  MAX_REQUEST_BYTES: z.string().default('64kb')
});

export const env = schema.parse(process.env);
