import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase } from './prisma/prisma.client.js';
// import { initializeWebSocket } from './config/websocket.config.js';
import { connectRedis, disconnectRedis } from './config/redis.config.js';
// import { cloudinaryConfig } from './config/cloudinary.config.js';

const httpServer = createServer(app);

// Graceful shutdown handling
const shutdown = async () => {
  logger.info('🛑 Shutting down server...');
  await disconnectRedis();
  httpServer.close(() => {
    logger.info('🚫 Server terminated');
    process.exit(0);
  });
};

process.on('uncaughtException', (err) => {
  logger.error('🚨 Uncaught Exception:', err.stack || err);
  shutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('🚨 Unhandled Rejection:', reason);
  shutdown();
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function startServer() {
  try {
    // Initialize core services
    await connectRedis();
    await connectDatabase();
    // await cloudinaryConfig();

    // Initialize WebSocket
    // initializeWebSocket(httpServer);

    // Start the server
    httpServer.listen(env.PORT, () => {
      logger.info(`
        🚀 Server running in ${env.NODE_ENV} mode
        📡 Port: ${env.PORT}
        ☁️ Cloud: ${env.CLOUDINARY_CLOUD_NAME}
        🔒 Redis: ${env.REDIS_URL ? 'Connected' : 'Disabled'}
      `);
    });
  } catch (error) {
    logger.error('🔥 Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default httpServer;
