// server.js - Updated with robust startup sequence
import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase } from './prisma/prisma.client.js';
import { connectRedis, disconnectRedis } from './config/redis.config.js';

const httpServer = createServer(app);
const PORT = env.PORT || 3000;

// Graceful shutdown handler
const shutdown = async (signal) => {
  logger.info(`🛑 Received ${signal}, shutting down...`);

  try {
    await disconnectDatabase();
    logger.info('🔌 Database connection closed');
  } catch (dbError) {
    logger.error('🚨 Database shutdown error:', dbError);
  }

  try {
    await disconnectRedis();
    logger.info('🔴 Redis connection closed');
  } catch (redisError) {
    logger.error('🚨 Redis shutdown error:', redisError);
  }

  httpServer.close(() => {
    logger.info('🚫 HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('🕛 Shutdown timeout forced exit');
    process.exit(1);
  }, 10000);
};

// Process event handlers
const registerProcessHandlers = () => {
  process
    .on('uncaughtException', (err) => {
      logger.error('🚨 Uncaught Exception:', err.stack || err);
      shutdown('UNCAUGHT_EXCEPTION');
    })
    .on('unhandledRejection', (reason) => {
      logger.error('🚨 Unhandled Rejection:', reason);
      shutdown('UNHANDLED_REJECTION');
    })
    .on('SIGTERM', () => shutdown('SIGTERM'))
    .on('SIGINT', () => shutdown('SIGINT'));
};

// Main server startup
const startServer = async () => {
  try {
    registerProcessHandlers();

    // Initialize core services
    await Promise.all([connectRedis(), connectDatabase()]);

    // Start server
    httpServer.listen(PORT, () => {
      logger.info(`
        🚀 Server running in ${env.NODE_ENV} mode on port ${env.PORT}
        🔒 Redis: ${env.REDIS_URL ? 'Connected' : 'Disabled'}
        🗄️  Database: ${env.POSTGRESQL_URI ? 'Connected' : 'Disabled'}
      `);
    });
  } catch (error) {
    logger.error('🔥 Critical startup failure:', error);
    await shutdown('STARTUP_FAILURE');
  }
};

// Start the application
startServer();

export default httpServer;
