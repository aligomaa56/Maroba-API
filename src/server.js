// server.js
import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase } from './prisma/prisma.client.js';

const httpServer = createServer(app);
const PORT = env.PORT || 3000;
let isShuttingDown = false;
let server = null;

// Graceful shutdown handler
const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`🛑 Received ${signal}, initiating graceful shutdown...`);

  const shutdownActions = [
    disconnectDatabase().catch(error => logger.error('Database shutdown error:', error))
    // Remove authService reference since it's not imported
  ];

  try {
    await Promise.allSettled(shutdownActions);

    if (server) {
      server.close(() => {
        logger.info('🚫 HTTP server closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }

    // Force exit after timeout
    setTimeout(() => {
      logger.error('🕛 Shutdown timeout forced exit');
      process.exit(1);
    }, 10000);
  } catch (error) {
    logger.error('Shutdown error:', error);
    process.exit(1);
  }
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
  // Prevent multiple server starts
  if (server) {
    logger.warn('Server is already running');
    return;
  }

  try {
    registerProcessHandlers();
    await connectDatabase();
    
    // Store server instance
    server = httpServer.listen(PORT, () => {
      logger.info(`🚀 Server running in ${env.NODE_ENV} mode on port ${PORT}`);
    });

    // Handle server-specific errors
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use`);
      } else {
        logger.error('Server error:', error);
      }
      shutdown('SERVER_ERROR');
    });

  } catch (error) {
    logger.error('🔥 Startup failed:', error);
    await shutdown('STARTUP_FAILURE');
  }
};

// Start the application
startServer();

export default httpServer;