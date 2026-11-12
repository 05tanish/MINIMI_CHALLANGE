import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './infrastructure/logging/logger.js';
app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'Minimi API listening'));
