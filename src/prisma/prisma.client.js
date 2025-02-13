// src/prisma/prisma.client.js
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.config.js';
import logger from '../middleware/logger.middleware.js';

class PrismaManager {
  static instance = null;
  static isConnected = false;
  static retryAttempts = 3;
  static retryDelay = 1000; // 1 second

  static async getInstance() {
    if (!this.instance) {
      this.instance = new PrismaClient({
        log: env.NODE_ENV === 'development' 
          ? ['info', 'warn', 'error'] 
          : ['warn', 'error'],
        errorFormat: 'minimal',
        datasources: {
          db: {
            url: env.POSTGRESQL_URI
          }
        }
      });

      // Add query monitoring middleware
      this.instance.$use(async (params, next) => {
        const start = Date.now();
        try {
          const result = await next(params);
          const duration = Date.now() - start;
          
          if (duration > 500) {
            logger.warn(
              `Slow query (${duration}ms): ${params.model || 'raw'}.${params.action}`,
              { model: params.model, action: params.action, duration }
            );
          }
          return result;
        } catch (error) {
          logger.error(
            `Database error in ${params.model || 'raw'}.${params.action}`,
            { error: error.message, query: params.args }
          );
          throw error;
        }
      });
    }
    return this.instance;
  }

  static async connect(attempts = 0) {
    if (this.isConnected) return;

    try {
      const client = await this.getInstance();
      await client.$connect();
      this.isConnected = true;
      logger.info('Database connection established');

      // Simple connection test
      if (env.NODE_ENV === 'production') {
        await client.$executeRaw`SELECT 1`;
      }
    } catch (error) {
      logger.error(`Database connection attempt ${attempts + 1} failed:`, error);

      if (attempts < this.retryAttempts) {
        logger.info(`Retrying connection in ${this.retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        return this.connect(attempts + 1);
      }

      logger.error('Max connection retries reached. Exiting...');
      process.exit(1);
    }
  }

  static async disconnect() {
    if (!this.isConnected || !this.instance) return;

    try {
      await this.instance.$disconnect();
      this.isConnected = false;
      this.instance = null;
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Error closing database connection:', error);
      throw error;
    }
  }

  static async executeWithRetry(operation, attempts = 0) {
    try {
      return await operation();
    } catch (error) {
      if (error.code === 'P1017' && attempts < this.retryAttempts) {
        logger.warn(`Connection pool timeout, retrying operation (${attempts + 1}/${this.retryAttempts})`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        return this.executeWithRetry(operation, attempts + 1);
      }
      throw error;
    }
  }
}

// Graceful shutdown handling
const shutdownHandler = async (signal) => {
  logger.info(`Received ${signal}, shutting down...`);
  await PrismaManager.disconnect();
  process.exit(0);
};

// Register shutdown handlers
['SIGTERM', 'SIGINT', 'SIGUSR2'].forEach(signal => {
  process.once(signal, () => shutdownHandler(signal));
});

export const prisma = await PrismaManager.getInstance();
export const connectDatabase = () => PrismaManager.connect();
export const disconnectDatabase = () => PrismaManager.disconnect();