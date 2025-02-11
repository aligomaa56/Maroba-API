import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient } from './redis.config.js';
import { env } from './env.config.js';
import logger from '../middleware/logger.middleware.js';

export const RouteType = {
  AUTHENTICATION: 'AUTHENTICATION',
  API: 'API',
  PUBLIC: 'PUBLIC',
};

const createRedisStore = (routeType) => {
  return redisClient?.isOpen
    ? new RedisStore({
        client: redisClient,
        prefix: `rate_limit:${routeType}:`,
      })
    : undefined;
};

const getRateLimitOptions = (routeType) => {
  const options = {
    authentication: {
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: 'Too many login attempts, please try again later.',
    },
    api: {
      windowMs: 60 * 1000,
      max: 100,
      message: 'API rate limit exceeded.',
    },
    public: {
      windowMs: 60 * 60 * 1000,
      max: 1000,
      message: 'Too many requests from this IP.',
    },
  };

  return {
    ...options[routeType.toLowerCase()],
    ...(env.RATE_LIMIT_OVERRIDES ? JSON.parse(env.RATE_LIMIT_OVERRIDES)[routeType] : {}),
  };
};

export const createRateLimiter = (routeType) => {
  const options = getRateLimitOptions(routeType);

  return rateLimit({
    ...options,
    store: createRedisStore(routeType),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}-${routeType}`,
    handler: (req, res, next) => {
      logger.warn(`Rate limit exceeded: ${routeType} - ${req.ip}`);
      next(new Error(options.message));
    },
  });
};
