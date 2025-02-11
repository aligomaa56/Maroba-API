import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.config.js';
import logger from '../middleware/logger.middleware.js';

// Singleton pattern for Prisma Client
const prisma = global.prisma || new PrismaClient({
  log: env.NODE_ENV === 'development' 
    ? ['query', 'info', 'warn', 'error']
    : ['warn', 'error'],
  errorFormat: 'minimal',
  datasources: {
    db: {
      url: env.POSTGRESQL_URI,
    },
  },
});

// Prevent multiple instances in development
if (env.NODE_ENV === 'development') {
  global.prisma = prisma;
}

// Middleware to monitor query performance
prisma.$use(async (params, next) => {
  const start = Date.now();
  try {
    const result = await next(params);
    const duration = Date.now() - start;

    // Log slow queries (threshold: 500ms)
    if (duration > 500) {
      logger.warn(`Slow query (${duration}ms): ${params.model}.${params.action}`, {
        model: params.model,
        action: params.action,
        duration,
      });
    }
    return result;
  } catch (error) {
    logger.error(`Database error in ${params.model}.${params.action}`, {
      error: error.message,
      query: params.args,
    });
    throw error;
  }
});

// Connection management
let isConnected = false;

const connectDatabase = async () => {
  if (isConnected) return;
  
  try {
    await prisma.$connect();
    isConnected = true;
    logger.info('Database connection established');

    // Production optimizations
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

// Graceful shutdown handling
const shutdownHandler = async (signal) => {
  logger.info(`Received ${signal}, shutting down...`);
  await disconnectDatabase();
  process.exit(0);
};

process.once('SIGTERM', shutdownHandler.bind(null, 'SIGTERM'));
process.once('SIGINT', shutdownHandler.bind(null, 'SIGINT'));
process.once('SIGUSR2', shutdownHandler.bind(null, 'SIGUSR2')); // For nodemon

// Connection health check
const HEALTH_CHECK_INTERVAL = env.NODE_ENV === 'production' ? 30000 : 60000;

const healthCheck = setInterval(async () => {
  if (!isConnected) return;
  
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    logger.error('Database connection health check failed:', error);
    isConnected = false;
    clearInterval(healthCheck);
    await disconnectDatabase();
    setTimeout(connectDatabase, 5000);
  }
}, HEALTH_CHECK_INTERVAL);

export { prisma, connectDatabase, disconnectDatabase };