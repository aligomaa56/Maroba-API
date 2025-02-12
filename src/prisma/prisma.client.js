// src/prisma/prisma.client.js
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.config.js';
import logger from '../middleware/logger.middleware.js';

const prisma = global.prisma || new PrismaClient({
  log: env.NODE_ENV === 'development' 
    ? ['info', 'warn', 'error']
    : ['warn', 'error'],
  errorFormat: 'minimal',
  datasources: {
    db: {
      url: env.POSTGRESQL_URI,
    },
  },
});

if (env.NODE_ENV === 'development') {
  global.prisma = prisma;
}

prisma.$use(async (params, next) => {
  const start = Date.now();
  try {
    const result = await next(params);
    const duration = Date.now() - start;

    // If it's a raw query (model is undefined), optionally ignore or use a different threshold.
    if (params.model === undefined && params.action === 'executeRaw') {
      // Optionally log at a different threshold, e.g., only log if over 2000ms:
      if (duration > 2000) {
        logger.warn(`Slow raw query (${duration}ms): ${params.action}`, { action: params.action, duration });
      }
    } else if (duration > 500) {
      logger.warn(`Slow query (${duration}ms): ${params.model}.${params.action}`, {
        model: params.model,
        action: params.action,
        duration,
      });
    }

    return result;
  } catch (error) {
    logger.error(`Database error in ${params.model || 'raw'}.${params.action}`, {
      error: error.message,
      query: params.args,
    });
    throw error;
  }
});

let isConnected = false;

const connectDatabase = async () => {
  if (isConnected) return;
  
  try {
    await prisma.$connect();
    isConnected = true;
    logger.info('Database connection established');

    if (env.NODE_ENV === 'production') {
      await prisma.$transaction([
        prisma.$executeRaw`SET lock_timeout = 10000`,
        prisma.$executeRaw`SET idle_in_transaction_session_timeout = 15000`,
        prisma.$executeRaw`SET statement_timeout = 15000`
      ]);
      logger.debug('Applied production database timeouts');
    }
  } catch (error) {
    logger.error('Database connection failed:', error);
    process.exit(1);
  }
};

const disconnectDatabase = async () => {
  if (!isConnected) return;
  
  try {
    await prisma.$disconnect();
    isConnected = false;
    logger.info('Database connection closed');
  } catch (error) {
    logger.error('Error closing database connection:', error);
    process.exit(1);
  }
};

const shutdownHandler = async (signal) => {
  logger.info(`Received ${signal}, shutting down...`);
  await disconnectDatabase();
  process.exit(0);
};

process.once('SIGTERM', shutdownHandler.bind(null, 'SIGTERM'));
process.once('SIGINT', shutdownHandler.bind(null, 'SIGINT'));
process.once('SIGUSR2', shutdownHandler.bind(null, 'SIGUSR2'));

// const HEALTH_CHECK_INTERVAL = env.NODE_ENV === 'production' ? 30000 : 60000;

// const healthCheck = setInterval(async () => {
//   if (!isConnected) return;
  
//   try {
//     await prisma.$queryRaw`SELECT 1`;
//   } catch (error) {
//     logger.error('Database connection health check failed:', error);
//     isConnected = false;
//     clearInterval(healthCheck);
//     await disconnectDatabase();
//     setTimeout(connectDatabase, 5000);
//   }
// }, HEALTH_CHECK_INTERVAL);

export { prisma, connectDatabase, disconnectDatabase };
