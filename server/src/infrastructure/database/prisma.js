import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
export const prisma = env.DATABASE_URL ? new PrismaClient({ log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'] }) : null;
