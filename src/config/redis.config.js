import { createClient } from 'redis';
import { env } from './env.config.js';
import logger from '../middleware/logger.middleware.js';
import { AppError } from '../middleware/error.middleware.js';

export const redisClient = env.REDIS_URL
  ? createClient({
      url: env.REDIS_URL,
      socket: {
        tls: env.REDIS_TLS === 'true',
        rejectUnauthorized: false,
      },
      password: env.REDIS_PASSWORD,
    })
  : null;

export async function connectRedis() {
  if (!redisClient) {
    return;
  }

  try {
    await redisClient.connect();
    logger.info('Connected to Redis successfully');

    redisClient.on('error', (err) => {
      logger.error('Redis connection error:', err);
      if (env.NODE_ENV === 'production') {
        throw new AppError(500, 'Redis connection failed');
      }
    });

    redisClient.on('reconnecting', () => logger.warn('Attempting to reconnect to Redis...'));
  } catch (error) {
    logger.error('Redis connection failed:', error);
    if (env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

export async function disconnectRedis() {
  if (redisClient?.isOpen) {
    await redisClient.quit();
    logger.info('Redis connection closed');
  }
}
