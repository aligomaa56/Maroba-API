import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.config.js';
import logger from '../middleware/logger.middleware.js';
import { AppError } from '../middleware/error.middleware.js';

class PrismaManager {
  static instance = null;
  static isConnecting = false;
  static isConnected = false;
  static retryAttempts = 5;
  static retryDelay = 2000;
  static connectionTimeout = 30000;

  static async getInstance() {
    if (!this.instance) {
      const connectionString = new URL(env.DATABASE_URL);
      // Add connection pool parameters to URL
      connectionString.searchParams.set('pgbouncer', 'true');
      connectionString.searchParams.set('connection_limit', '10');
      connectionString.searchParams.set('pool_timeout', '20');
      connectionString.searchParams.set('connect_timeout', '10');

      this.instance = new PrismaClient({
        log: env.NODE_ENV === 'development' 
          ? ['info', 'warn', 'error'] 
          : ['warn', 'error'],
        errorFormat: 'minimal',
        datasources: {
          db: {
            url: connectionString.toString()
          }
        },
        // Add connection handling settings
        __internal: {
          engine: {
            connectionTimeout: this.connectionTimeout,
            pollInterval: 100  // Poll interval for connection status
          }
        }
      });

      this.instance.$use(async (params, next) => {
        const start = Date.now();
        const queryInfo = `${params.model || 'raw'}.${params.action}`;
        
        try {
          const result = await Promise.race([
            next(params),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Query timeout')), 10000)
            )
          ]);

          const duration = Date.now() - start;
          if (duration > 500) {
            logger.warn(`Slow query (${duration}ms): ${queryInfo}`, {
              duration,
              query: queryInfo,
              args: params.args
            });
          }
          return result;
        } catch (error) {
          const duration = Date.now() - start;
          logger.error(`Database error in ${queryInfo}`, {
            error: error.message,
            duration,
            query: queryInfo,
            args: params.args
          });
          throw error;
        }
      });
    }
    return this.instance;
  }

  static async connect(attempts = 0) {
    if (this.isConnected) return;
    if (this.isConnecting) {
      logger.warn('Connection attempt already in progress');
      return;
    }

    this.isConnecting = true;

    try {
      const client = await this.getInstance();
      
      // Test connection with timeout
      const connectionPromise = Promise.race([
        client.$connect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), this.connectionTimeout)
        )
      ]);

      await connectionPromise;
      
      // Verify connection with a test query
      await client.$executeRaw`SELECT 1`;
      
      this.isConnected = true;
      this.isConnecting = false;
      logger.info('Database connection established');
    } catch (error) {
      this.isConnecting = false;
      logger.error(`Connection attempt ${attempts + 1} failed: ${error.message}`);

      if (attempts < this.retryAttempts) {
        const delay = Math.min(this.retryDelay * Math.pow(2, attempts), 30000); // Exponential backoff with max 30s
        logger.info(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.connect(attempts + 1);
      }

      logger.error('Max retries reached. Exiting...');
      throw new AppError(
        500, 
        'Database connection failed after multiple attempts', 
        false, 
        { originalError: error.message }
      );
    }
  }

  static async disconnect() {
    if (!this.isConnected || !this.instance) return;

    try {
      // Add timeout to disconnect operation
      await Promise.race([
        this.instance.$disconnect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Disconnect timeout')), 5000)
        )
      ]);
      
      this.isConnected = false;
      this.isConnecting = false;
      this.instance = null;
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Disconnection error:', error);
      // Force disconnect on error
      this.instance = null;
      this.isConnected = false;
      this.isConnecting = false;
      throw error;
    }
  }

  // Add connection reset method
  static async resetConnection() {
    logger.info('Resetting database connection...');
    await this.disconnect();
    await this.connect();
  }
}

// Enhanced shutdown handler with timeout
const shutdownHandler = async (signal) => {
  logger.info(`Received ${signal}, initiating graceful shutdown...`);
  
  try {
    await Promise.race([
      PrismaManager.disconnect(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Shutdown timeout')), 10000)
      )
    ]);
    process.exit(0);
  } catch (error) {
    logger.error('Forced shutdown due to timeout:', error);
    process.exit(1);
  }
};

// Register shutdown handlers
['SIGTERM', 'SIGINT', 'SIGUSR2'].forEach(signal => {
  process.once(signal, () => shutdownHandler(signal));
});

export const prisma = await PrismaManager.getInstance();
export const connectDatabase = () => PrismaManager.connect();
export const disconnectDatabase = () => PrismaManager.disconnect();
export const resetDatabaseConnection = () => PrismaManager.resetConnection();