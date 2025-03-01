import app from './app.js';
import { env } from './config/env.config.js';
import { createServer } from 'http';
import logger from './middleware/logger.middleware.js';
import { connectDatabase, disconnectDatabase, resetDatabaseConnection } from './prisma/prisma.client.js';
import notificationService from './services/notification.service.js';

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
    
    // Configuration timeouts
    this.timeouts = {
      dbReset: 5000,      // 5 seconds for db reset
      dbShutdown: 5000,   // 5 seconds for db shutdown
      serverClose: 5000,  // 5 seconds for server close
      keepAlive: 60000    // 1 minute keep-alive timeout
    };
    
    // Track active connections
    this.connections = new Set();
    
    ServerInstance.instance = this;
  }

  async resetDatabaseWithTimeout() {
    try {
      await Promise.race([
        resetDatabaseConnection(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Database reset timeout')), this.timeouts.dbReset)
        )
      ]);
      logger.info('Database connection reset successful');
      return true;
    } catch (error) {
      logger.error('Database reset failed:', error);
      throw error;
    }
  }

  async handleDatabaseError(error) {
    if (!error?.message?.includes('connection')) {
      return false;
    }

    logger.warn('Database connection issue detected, attempting reset...');
    try {
      return await this.resetDatabaseWithTimeout();
    } catch (resetError) {
      logger.error('Database reset failed:', resetError);
      return false;
    }
  }

  async shutdown(signal) {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }
    
    this.isShuttingDown = true;
    logger.info(`🛑 Received ${signal}, initiating graceful shutdown...`);

    try {
      // Stop accepting new connections
      if (this.server) {
        this.server.close();
      }

      // Close all keep-alive connections
      for (const socket of this.connections) {
        socket.destroy();
      }

      // Disconnect database with timeout
      await Promise.race([
        disconnectDatabase(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Database disconnect timeout')), this.timeouts.dbShutdown)
        )
      ]).catch(error => {
        logger.error('Database shutdown error:', error);
        // Continue shutdown even if database disconnect fails
      });

      if (this.server) {
        await new Promise((resolve) => {
          const forceShutdown = setTimeout(() => {
            logger.warn('Server close timeout, forcing close');
            resolve();
          }, this.timeouts.serverClose);

          this.server.close(() => {
            clearTimeout(forceShutdown);
            resolve();
          });
        });
        
        logger.info('🚫 HTTP server closed');
      }

      process.exit(0);
    } catch (error) {
      logger.error('Shutdown error:', error);
      process.exit(1);
    }
  }

  trackConnection(socket) {
    this.connections.add(socket);
    socket.on('close', () => this.connections.delete(socket));
    
    // Set keep-alive timeout
    socket.setKeepAlive(true, this.timeouts.keepAlive);
    socket.setTimeout(this.timeouts.keepAlive);
  }

  registerProcessHandlers() {
    const handleException = async (err) => {
      logger.error('🚨 Critical error:', err.stack || err);
      
      if (await this.handleDatabaseError(err)) {
        logger.info('Database recovered after error');
        return;
      }
      
      await this.shutdown('CRITICAL_ERROR');
    };

    process
      .on('uncaughtException', handleException)
      .on('unhandledRejection', handleException)
      .on('SIGTERM', () => this.shutdown('SIGTERM'))
      .on('SIGINT', () => this.shutdown('SIGINT'));
  }

  async start() {
    if (this.isStarting || this.server) {
      logger.warn(this.isStarting ? 'Server startup in progress' : 'Server already running');
      return;
    }

    this.isStarting = true;

    try {
      this.registerProcessHandlers();
      await connectDatabase();
      logger.info('Database connection established');

      await notificationService.initialize();
      logger.info('Email service initialized');

      return new Promise((resolve, reject) => {
        this.server = this.httpServer.listen(this.PORT, () => {
          logger.info(`🚀 Server running in ${env.NODE_ENV} mode on port ${this.PORT}`);
          this.isStarting = false;

          // Track connections for graceful shutdown
          this.server.on('connection', (socket) => this.trackConnection(socket));
          
          resolve(this.server);
        });

        this.server.on('error', async (error) => {
          this.isStarting = false;
          if (error.code === 'EADDRINUSE') {
            logger.error(`Port ${this.PORT} is already in use`);
          } else {
            logger.error('Server error:', error);
            await this.handleDatabaseError(error);
          }
          reject(error);
          await this.shutdown('SERVER_ERROR');
        });
      });
    } catch (error) {
      this.isStarting = false;
      logger.error('🔥 Startup failed:', error);
      
      if (await this.handleDatabaseError(error)) {
        logger.info('Retrying server start after database reset...');
        return this.start();
      }
      
      await this.shutdown('STARTUP_FAILURE');
      throw error;
    }
  }
}

const serverInstance = new ServerInstance();

serverInstance.start().catch(error => {
  logger.error('Failed to start server:', error);
});

export default serverInstance.httpServer;
