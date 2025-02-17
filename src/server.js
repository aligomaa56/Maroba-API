import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase, resetDatabaseConnection } from './prisma/prisma.client.js';

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
    this.dbResetTimeout = 5000; // 5 seconds timeout for db reset
    
    ServerInstance.instance = this;
  }

  async resetDatabaseWithTimeout() {
    try {
      await Promise.race([
        resetDatabaseConnection(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Database reset timeout')), this.dbResetTimeout)
        )
      ]);
      logger.info('Database connection reset successful');
    } catch (error) {
      logger.error('Database reset failed:', error);
      throw error;
    }
  }

  async handleDatabaseError(error) {
    if (error.message.includes('connection')) {
      logger.warn('Database connection issue detected, attempting reset...');
      try {
        await this.resetDatabaseWithTimeout();
        return true;
      } catch (resetError) {
        logger.error('Database reset failed:', resetError);
        return false;
      }
    }
    return false;
  }

  async shutdown(signal) {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }
    
    this.isShuttingDown = true;
    logger.info(`🛑 Received ${signal}, initiating graceful shutdown...`);

    try {
      await Promise.race([
        disconnectDatabase(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Database disconnect timeout')), 5000)
        )
      ]).catch(error => logger.error('Database shutdown error:', error));

      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
          
          // Force close after timeout
          setTimeout(() => {
            logger.warn('Server close timeout, forcing close');
            resolve();
          }, 5000);
        });
        
        logger.info('🚫 HTTP server closed');
      }

      process.exit(0);
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
    const handleException = async (err) => {
      logger.error('🚨 Critical error:', err.stack || err);
      
      // Attempt database reset on connection errors
      if (await this.handleDatabaseError(err)) {
        logger.info('Database recovered after error');
        return;
      }
      
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

        this.server.on('error', async (error) => {
          this.isStarting = false;
          if (error.code === 'EADDRINUSE') {
            logger.error(`Port ${this.PORT} is already in use`);
          } else {
            logger.error('Server error:', error);
            // Attempt database reset on server errors
            await this.handleDatabaseError(error);
          }
          reject(error);
          this.shutdown('SERVER_ERROR');
        });
      });
    } catch (error) {
      this.isStarting = false;
      logger.error('🔥 Startup failed:', error);
      
      // Attempt database reset on startup failure
      if (await this.handleDatabaseError(error)) {
        logger.info('Retrying server start after database reset...');
        return this.start();
      }
      
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

export default serverInstance.httpServer;