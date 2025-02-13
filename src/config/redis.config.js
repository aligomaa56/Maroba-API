import { createClient } from 'redis';
import { env } from './env.config.js';
import logger from '../middleware/logger.middleware.js';

const getRedisConfig = () => {
  if (env.NODE_ENV === 'development') {
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
  }

  // Production configuration
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is required in production environment');
  }

  return {
    url: env.REDIS_URL,
    socket: {
      tls: true,
      rejectUnauthorized: false,
      reconnectStrategy: (retries) => Math.min(retries * 100, 5000),
    },
    password: env.REDIS_PASSWORD,
  };
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
    if (env.NODE_ENV === 'production') process.exit(1);
  }
}

export async function disconnectRedis() {
  if (redisClient.isOpen) {
    await redisClient.quit();
    logger.info('Redis connection closed');
  }
}
