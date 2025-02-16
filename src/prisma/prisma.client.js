// src/prisma/prisma.client.js - Optimized for Serverless
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.config.js';
import logger from '../middleware/logger.middleware.js';

// Global instance for serverless reuse
const globalPrisma = globalThis.__prisma || undefined;

class PrismaManager {
  static instance = globalPrisma || new PrismaClient({
    log: env.NODE_ENV === 'development' 
      ? ['info', 'warn', 'error'] 
      : ['warn', 'error'],
    datasources: {
      db: {
        url: `${env.DATABASE_URL}?pgbouncer=true&pool_timeout=30&connection_limit=5`
      }
    }
  });

  static async connect() {
    if (this.instance.$isConnected) return;

    try {
      await this.instance.$connect();
      logger.info('Database connection established');
      
      // Store in global for serverless reuse
      if (env.NODE_ENV === 'production') {
        globalThis.__prisma = this.instance;
      }
    } catch (error) {
      logger.error('Connection failed:', error);
      await this.instance.$disconnect();
      throw error;
    }
  }

  static async disconnect() {
    if (!this.instance.$isConnected) return;
    
    await this.instance.$disconnect();
    logger.info('Database connection closed');
  }
}

// Serverless connection handling
if (env.NODE_ENV === 'production') {
  PrismaManager.connect().catch(() => process.exit(1));
}

export const prisma = PrismaManager.instance;
export const connectDatabase = () => PrismaManager.connect();
export const disconnectDatabase = () => PrismaManager.disconnect();