// server.js - Updated with robust startup sequence
import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase } from './prisma/prisma.client.js';
import { authService } from './services/auth.service.js';

const httpServer = createServer(app);
const PORT = env.PORT || 3000;
let isShuttingDown = false;

// Graceful shutdown handler
const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`🛑 Received ${signal}, initiating graceful shutdown...`);

  const shutdownActions = [
    disconnectDatabase().catch(error => logger.error('Database shutdown error:', error)),
    authService.cleanExpiredTokens().catch(error => logger.error('Token cleanup error:', error)),
  ];

  await Promise.allSettled(shutdownActions);

  httpServer.close(() => {
    logger.info('🚫 HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('🕛 Shutdown timeout forced exit');
    process.exit(1);
  }, 10000);
};

// Process event handlers
const registerProcessHandlers = () => {
  const handleException = (err) => {
    logger.error('🚨 Critical error:', err.stack || err);
    shutdown('CRITICAL_ERROR');
  };

  process
    .on('uncaughtException', handleException)
    .on('unhandledRejection', handleException)
    .on('SIGTERM', () => shutdown('SIGTERM'))
    .on('SIGINT', () => shutdown('SIGINT'));
};

// Main server startup
const startServer = async () => {
  try {
    registerProcessHandlers();

    // Single database connection
    await connectDatabase();
    
    // Start token cleanup scheduler
    setInterval(() => {
      authService.cleanExpiredTokens()
        .catch(error => logger.error('Scheduled token cleanup failed:', error));
    }, 3600000); // Every hour

    httpServer.listen(PORT, () => {
      logger.info(`🚀 Server running in ${env.NODE_ENV} mode on port ${PORT}`);
    });
  } catch (error) {
    logger.error('🔥 Startup failed:', error);
    await shutdown('STARTUP_FAILURE');
  }
};

// Start the application
startServer();

export default httpServer;
