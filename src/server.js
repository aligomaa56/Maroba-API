import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase } from './prisma/prisma.client.js';
import { connectRedis, disconnectRedis } from './config/redis.config.js';

const httpServer = createServer(app);
const PORT = env.PORT || 3000;
let isServerListening = false; // Prevent multiple listens

const shutdown = async (signal) => {
  logger.info(`🛑 Shutting down (${signal})...`);

  try {
    await Promise.all([
      disconnectDatabase(),
      disconnectRedis(),
      new Promise((resolve) => {
        if (isServerListening) {
          httpServer.close(() => {
            isServerListening = false;
            resolve();
          });
        } else resolve();
      })
    ]);

    logger.info('🚫 Server terminated');
    process.exit(0);
  } catch (error) {
    logger.error('Force shutdown:', error);
    process.exit(1);
  }
};

const registerProcessHandlers = () => {
  const handleException = (err) => {
    logger.error('Critical error:', err);
    shutdown('CRASH');
  };

  process.on('uncaughtException', handleException);
  process.on('unhandledRejection', handleException);
  ['SIGTERM', 'SIGINT'].forEach(signal => process.on(signal, shutdown));
};

const startServer = async () => {
  try {
    registerProcessHandlers();

    logger.info('Connecting to Redis...');
    await connectRedis();
    
    logger.info('Connecting to Database...');
    await connectDatabase();

    if (!isServerListening) {
      httpServer.listen(PORT, () => {
        isServerListening = true;
        logger.info(`
          🚀 Server running in ${env.NODE_ENV}
          📡 Port: ${PORT}
          🔒 Redis: Connected
          🗄️  Database: Connected
        `);
      });
    }
  } catch (error) {
    logger.error('Startup failed:', error);
    await shutdown('STARTUP_FAILURE');
  }
};

startServer();

export default httpServer;