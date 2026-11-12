import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const environmentName = (process.env.NODE_ENV ?? 'development').toUpperCase();
if (!process.env.DATABASE_URL?.trim()) process.env.DATABASE_URL = process.env[`DATABASE_URL_${environmentName}`] ?? '';
if (!process.env.GEMINI_API_KEY?.trim()) process.env.GEMINI_API_KEY = process.env[`GEMINI_API_KEY_${environmentName}`] ?? '';

if (!process.env.DATABASE_URL) {
  console.error(`DATABASE_URL or DATABASE_URL_${environmentName} must be configured before running Prisma.`);
  process.exit(1);
}

const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
if (result.error) { console.error('Unable to start Prisma CLI:', result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
