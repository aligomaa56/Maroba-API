// src/prisma/prisma.client.js - Revised with AppError for Connection Failures
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.config.js';
import logger from '../middleware/logger.middleware.js';
import { AppError } from '../middleware/error.middleware.js';

class PrismaManager {
  static instance = null;
  static isConnected = false;
  static retryAttempts = 5; // Increased from 3
  static retryDelay = 2000; // Increased from 1s

  static async getInstance() {
    if (!this.instance) {
      this.instance = new PrismaClient({
        log: env.NODE_ENV === 'development' 
          ? ['info', 'warn', 'error'] 
          : ['warn', 'error'],
        errorFormat: 'minimal',
        datasources: {
          db: {
            url: `${env.POSTGRESQL_URI}?pgbouncer=true&pool_timeout=15&connection_limit=20`
          }
        }
      });

      // Query monitoring middleware
      this.instance.$use(async (params, next) => {
        const start = Date.now();
        try {
          const result = await next(params);
          const duration = Date.now() - start;
          if (duration > 500) {
            logger.warn(`Slow query (${duration}ms): ${params.model || 'raw'}.${params.action}`);
          }
          return result;
        } catch (error) {
          logger.error(`Database error in ${params.model || 'raw'}.${params.action}`, error);
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

      // Connection test
      await client.$executeRaw`SELECT 1`;
    } catch (error) {
      logger.error(`Connection attempt ${attempts + 1} failed: ${error.message}`);

      if (attempts < this.retryAttempts) {
        logger.info(`Retrying in ${this.retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        return this.connect(attempts + 1);
      }

      logger.error('Max retries reached. Exiting...');
      // Wrap the original error in an AppError
      throw new AppError(500, 'Failed to connect to the database after multiple attempts', false, { originalError: error.message });
    }
  }

  static async disconnect() {
    if (!this.isConnected || !this.instance) return;

    try {
      await this.instance.$disconnect();
      this.isConnected = false;
      this.instance = null; // Reset instance
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Disconnection error:', error);
      throw error;
    }
  }
}

// Graceful shutdown
const shutdownHandler = async (signal) => {
  logger.info(`Received ${signal}, shutting down...`);
  await PrismaManager.disconnect();
  process.exit(0);
};

['SIGTERM', 'SIGINT', 'SIGUSR2'].forEach(signal => {
  process.once(signal, () => shutdownHandler(signal));
});

export const prisma = await PrismaManager.getInstance();
export const connectDatabase = () => PrismaManager.connect();
export const disconnectDatabase = () => PrismaManager.disconnect();
