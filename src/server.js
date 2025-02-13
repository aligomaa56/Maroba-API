// server.js - Final optimized version
import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase } from './prisma/prisma.client.js';
import { connectRedis, disconnectRedis } from './config/redis.config.js';

const httpServer = createServer(app);
const PORT = env.PORT || 3000;
let isServerRunning = false;

// Enhanced graceful shutdown handler
const shutdown = async (signal) => {
  logger.info(`🛑 Received ${signal}, initiating shutdown...`);

  const shutdownActions = [
    disconnectDatabase().then(() =>
      logger.info('🔌 Database connection closed')
    ),
    disconnectRedis().then(() => logger.info('🔴 Redis connection closed')),
    new Promise((resolve) => httpServer.close(resolve)),
  ];

  try {
    await Promise.race([
      Promise.all(shutdownActions),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout')), 10000)
      ),
    ]);
    logger.info('🚫 Server terminated gracefully');
  } catch (error) {
    logger.error('🕛 Forceful shutdown:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
};

// Robust process handling
const registerProcessHandlers = () => {
  const handleException = (err) => {
    logger.error('🚨 Critical Exception:', err.stack || err);
    shutdown('UNCAUGHT_EXCEPTION');
  };

  const handleRejection = (reason) => {
    logger.error('🚨 Unhandled Rejection:', reason);
    shutdown('UNHANDLED_REJECTION');
  };

  process
    .on('uncaughtException', handleException)
    .on('unhandledRejection', handleRejection)
    .on('SIGTERM', () => shutdown('SIGTERM'))
    .on('SIGINT', () => shutdown('SIGINT'))
    .on('exit', () => logger.info('👋 Process exited'));
};

// Optimized server startup
const startServer = async () => {
  if (isServerRunning) {
    logger.warn('⚠️ Server already running');
    return;
  }

  try {
    registerProcessHandlers();

    // Parallel service initialization
    await Promise.allSettled([connectRedis(), connectDatabase()]);

    httpServer.listen(PORT, () => {
      isServerRunning = true;
      logger.info(`
        🚀 Server running in ${env.NODE_ENV} mode
        📡 Port: ${PORT}
        🔒 Redis: ${env.REDIS_URL ? 'Connected' : 'Disabled'}
        🗄️  Database: Connected
      `);
    });

    // Handle Vercel serverless specific behavior
    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} already in use`);
        shutdown('PORT_CONFLICT');
      } else {
        logger.error('💥 Server error:', err);
      }
    });
  } catch (error) {
    logger.error('🔥 Critical startup failure:', error);
    await shutdown('STARTUP_FAILURE');
  }
};

// Start the application with existence check
if (!isServerRunning) {
  startServer();
} else {
  logger.info('ℹ️ Server instance already exists');
}

export default httpServer;
