import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.config.js';
import logger from '../middleware/logger.middleware.js';

// Initialize Prisma Client without extra URL parameters to avoid unsupported options
const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  errorFormat: 'minimal',
  datasources: {
    db: {
      url: env.POSTGRESQL_URI, // Use only the base connection string
    },
  },
});

// Middleware to monitor query performance
prisma.$use(async (params, next) => {
  const start = Date.now();
  try {
    const result = await next(params);
    const duration = Date.now() - start;

    // Log queries that take longer than 500ms
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

let isConnected = false;

const connectDatabase = async () => {
  if (isConnected) return;
  
  try {
    await prisma.$connect();
    isConnected = true;
    logger.info('Database connection established');

    // Optional: Production-specific optimizations (adjust or remove as needed)
    if (env.NODE_ENV === 'production') {
      await prisma.$transaction([
        prisma.$executeRaw`SET lock_timeout = 10000`, // 10s
        prisma.$executeRaw`SET idle_in_transaction_session_timeout = 15000`, // 15s
        prisma.$executeRaw`SET statement_timeout = 15000` // 15s
      ]);
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

// Robust shutdown handling
const shutdownHandler = async (signal) => {
  logger.info(`Received ${signal}, shutting down...`);
  await disconnectDatabase();
  process.exit(0);
};

process.once('SIGTERM', () => shutdownHandler('SIGTERM'));
process.once('SIGINT', () => shutdownHandler('SIGINT'));
process.once('SIGUSR2', () => shutdownHandler('SIGUSR2')); // For nodemon restarts

// Connection health check (every 30 seconds)
// This check verifies that the connection is still alive. If not, it attempts a reconnection.
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

setInterval(async () => {
  if (!isConnected) return;
  
  try {
    // Simple health check query; adjust if needed
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    logger.error('Database connection health check failed:', error);
    isConnected = false;
    await disconnectDatabase();
    // Optionally, wait a moment before reconnecting to avoid hammering the server
    setTimeout(connectDatabase, 5000); // Try reconnecting after 5 seconds
  }
}, HEALTH_CHECK_INTERVAL);

export { prisma, connectDatabase, disconnectDatabase };
