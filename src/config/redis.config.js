// src/config/redis.config.js - Revised for Two Types of Configuration
import { createClient } from 'redis';
import { env } from './env.config.js';
import logger from '../middleware/logger.middleware.js';
import { AppError } from '../middleware/error.middleware.js';

const getRedisConfig = () => {
  if (env.NODE_ENV === 'development') {
    // Development configuration: Connect to local Redis
    if (env.DEV_REDIS_URL) {
      return {
        url: env.DEV_REDIS_URL,
        socket: {
          tls: false,
          reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
        },
      };
    }
    return {
      socket: {
        host: '127.0.0.1',
        port: 6379,
        tls: false,
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
      },
    };
  } else if (env.NODE_ENV === 'production') {
    // Production configuration: Use Upstash configuration
    if (!env.REDIS_URL) {
      throw new AppError(500, 'REDIS_URL is required in production environment');
    }
    return {
      url: env.REDIS_URL,
      username: 'default', // Required by Upstash
      password: env.REDIS_PASSWORD,
      socket: {
        // Use TLS settings based on the REDIS_TLS environment variable.
        tls:
          env.REDIS_TLS === 'true'
            ? {
                rejectUnauthorized: false, // Bypass certificate validation if needed
              }
            : undefined,
        connectTimeout: 10000, // 10 seconds timeout for connection
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000),
      },
    };
  } else {
    // Fallback configuration (if NODE_ENV is neither development nor production)
    return {
      socket: {
        host: '127.0.0.1',
        port: 6379,
        tls: false,
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
      },
    };
  }
};

export const redisClient = createClient(getRedisConfig());

export async function connectRedis() {
  if (env.NODE_ENV === 'test') return;

  try {
    await redisClient.connect();
    logger.info(`Connected to Redis (${env.NODE_ENV} environment)`);

    redisClient.on('error', (err) => logger.error('Redis error:', err));
    redisClient.on('reconnecting', () => logger.warn('Redis reconnecting...'));
    redisClient.on('ready', () => logger.info('Redis connection ready'));
  } catch (error) {
    logger.error('Redis connection failed:', error);
    // Throw an AppError to let the server startup handle the failure gracefully
    throw new AppError(500, 'Failed to connect to Redis', false, {
      originalError: error.message,
    });
  }
}

export async function disconnectRedis() {
  if (redisClient.isOpen) {
    await redisClient.quit();
    logger.info('Redis connection closed');
  }
}
