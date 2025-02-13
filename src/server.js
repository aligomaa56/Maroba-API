// server.js
import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase } from './prisma/prisma.client.js';
import { connectRedis, disconnectRedis } from './config/redis.config.js';

const httpServer = createServer(app);
const PORT = env.PORT || 3000;

// Enhanced graceful shutdown handler
const shutdown = async (signal) => {
  logger.info(`🛑 Received ${signal}, initiating shutdown...`);

  try {
    await Promise.all([
      disconnectDatabase().catch(err => logger.error('Database disconnect error:', err)),
      disconnectRedis().catch(err => logger.error('Redis disconnect error:', err)),
      new Promise((resolve) => {
        httpServer.close(resolve);
      })
    ]);
    
    logger.info('🚫 Server terminated gracefully');
    process.exit(0);
  } catch (error) {
    logger.error('🕛 Forceful shutdown:', error);
    process.exit(1);
  }
};

// Robust process handling
const registerProcessHandlers = () => {
  process.on('uncaughtException', (err) => {
    logger.error('🚨 Critical Exception:', err);
    shutdown('UNCAUGHT_EXCEPTION');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('🚨 Unhandled Rejection:', reason);
    shutdown('UNHANDLED_REJECTION');
  });

  ['SIGTERM', 'SIGINT'].forEach(signal => {
    process.on(signal, () => shutdown(signal));
  });
};

// Single startup function
const startServer = async () => {
  try {
    registerProcessHandlers();

    // Sequential service initialization
    logger.info('Connecting to Redis...');
    await connectRedis();
    
    logger.info('Connecting to Database...');
    await connectDatabase();

    // Only start listening after services are connected
    httpServer.listen(PORT, () => {
      logger.info(`
        🚀 Server running in ${env.NODE_ENV} mode
        📡 Port: ${PORT}
        🔒 Redis: Connected
        🗄️  Database: Connected
      `);
    });

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

// Start the application
startServer();

export default httpServer;