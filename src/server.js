// server.js
import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase } from './prisma/prisma.client.js';

class ServerInstance {
  constructor() {
    if (ServerInstance.instance) {
      return ServerInstance.instance;
    }
    
    this.httpServer = createServer(app);
    this.PORT = env.PORT || 3000;
    this.isShuttingDown = false;
    this.isStarting = false;
    this.server = null;
    
    ServerInstance.instance = this;
  }

  async shutdown(signal) {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }
    
    this.isShuttingDown = true;
    logger.info(`🛑 Received ${signal}, initiating graceful shutdown...`);

    try {
      await disconnectDatabase().catch(error => 
        logger.error('Database shutdown error:', error)
      );

      if (this.server) {
        this.server.close(() => {
          logger.info('🚫 HTTP server closed');
          process.exit(0);
        });

        // Handle any remaining connections
        const connections = await this.getConnections();
        connections.forEach(connection => connection.destroy());
      } else {
        process.exit(0);
      }

      setTimeout(() => {
        logger.error('🕛 Shutdown timeout forced exit');
        process.exit(1);
      }, 10000);
    } catch (error) {
      logger.error('Shutdown error:', error);
      process.exit(1);
    }
  }

  async getConnections() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve([]);
        return;
      }
      this.server.getConnections((error, count) => {
        if (error) reject(error);
        resolve(count);
      });
    });
  }

  registerProcessHandlers() {
    const handleException = (err) => {
      logger.error('🚨 Critical error:', err.stack || err);
      this.shutdown('CRITICAL_ERROR');
    };

    process
      .on('uncaughtException', handleException)
      .on('unhandledRejection', handleException)
      .on('SIGTERM', () => this.shutdown('SIGTERM'))
      .on('SIGINT', () => this.shutdown('SIGINT'));
  }

  async start() {
    if (this.isStarting) {
      logger.warn('Server startup already in progress');
      return;
    }

    if (this.server) {
      logger.warn('Server is already running');
      return;
    }

    this.isStarting = true;

    try {
      this.registerProcessHandlers();
      await connectDatabase();

      return new Promise((resolve, reject) => {
        this.server = this.httpServer.listen(this.PORT, () => {
          logger.info(`🚀 Server running in ${env.NODE_ENV} mode on port ${this.PORT}`);
          this.isStarting = false;
          resolve(this.server);
        });

        this.server.on('error', (error) => {
          this.isStarting = false;
          if (error.code === 'EADDRINUSE') {
            logger.error(`Port ${this.PORT} is already in use`);
          } else {
            logger.error('Server error:', error);
          }
          reject(error);
          this.shutdown('SERVER_ERROR');
        });
      });
    } catch (error) {
      this.isStarting = false;
      logger.error('🔥 Startup failed:', error);
      await this.shutdown('STARTUP_FAILURE');
      throw error;
    }
  }
}

// Create single instance
const serverInstance = new ServerInstance();

// Start the application
serverInstance.start().catch(error => {
  logger.error('Failed to start server:', error);
});

// Export the singleton instance
export default serverInstance.httpServer;