// src/prisma/prisma.client.js
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.config.js';
import logger from '../middleware/logger.middleware.js';

// Initialize Prisma client
const prisma =
  global.prisma ||
  new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? ['info', 'warn', 'error']
        : ['warn', 'error'],
    errorFormat: 'minimal',
    datasources: {
      db: {
        url: env.POSTGRESQL_URI,
      },
    },
  });

// Prevent multiple Prisma clients in development
if (env.NODE_ENV === 'development') {
  global.prisma = prisma;
}

// Middleware for logging slow queries
prisma.$use(async (params, next) => {
  const start = Date.now();
  try {
    const result = await next(params);
    const duration = Date.now() - start;

    if (params.model === undefined && params.action === 'executeRaw') {
      if (duration > 2000) {
        logger.warn(`Slow raw query (${duration}ms): ${params.action}`, {
          action: params.action,
          duration,
        });
      }
    } else if (duration > 500) {
      logger.warn(
        `Slow query (${duration}ms): ${params.model}.${params.action}`,
        {
          model: params.model,
          action: params.action,
          duration,
        }
      );
    }

    return result;
  } catch (error) {
    logger.error(
      `Database error in ${params.model || 'raw'}.${params.action}`,
      {
        error: error.message,
        query: params.args,
      }
    );
    throw error;
  }
});

let isConnected = false;

const connectDatabase = async () => {
  if (isConnected) return; // ✅ Prevent duplicate connections

  try {
    await prisma.$connect();
    isConnected = true;
    logger.info('Database connection established');

    if (env.NODE_ENV === 'production') {
      await prisma.$executeRaw`SELECT 1`; // Warmup query
    }
  } catch (error) {
    logger.error('Database connection failed:', error);
    process.exit(1);
  }
};

const disconnectDatabase = async () => {
  if (!isConnected) return; // ✅ Prevent duplicate disconnections

  try {
    await prisma.$disconnect();
    isConnected = false;
    logger.info('Database connection closed');
  } catch (error) {
    logger.error('Error closing database connection:', error);
    process.exit(1);
  }
};

// Graceful shutdown handling
const shutdownHandler = async (signal) => {
  logger.info(`Received ${signal}, shutting down...`);
  await disconnectDatabase();
  process.exit(0);
};

process.once('SIGTERM', shutdownHandler.bind(null, 'SIGTERM'));
process.once('SIGINT', shutdownHandler.bind(null, 'SIGINT'));
process.once('SIGUSR2', shutdownHandler.bind(null, 'SIGUSR2'));

export { prisma, connectDatabase, disconnectDatabase };
