import rateLimit from 'express-rate-limit';
import { env } from './env.config.js';
import logger from '../middleware/logger.middleware.js';

export const RouteType = {
  AUTHENTICATION: 'AUTHENTICATION',
  API: 'API',
  PUBLIC: 'PUBLIC',
};

// Cache rate limit options to avoid recalculating
const optionsCache = new Map();

const getRateLimitOptions = (routeType) => {
  // Check cache first
  const cachedOptions = optionsCache.get(routeType);
  if (cachedOptions) return cachedOptions;

  const options = {
    authentication: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10,
      message: 'Too many login attempts, please try again later.',
      skipSuccessfulRequests: true, // Don't count successful logins
    },
    api: {
      windowMs: 60 * 1000, // 1 minute
      max: 100,
      message: 'API rate limit exceeded.',
      skipFailedRequests: false, // Count both successful and failed requests
    },
    public: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 1000,
      message: 'Too many requests from this IP.',
      skipFailedRequests: true, // Don't count failed requests
    },
  };

  const baseOptions = options[routeType.toLowerCase()];
  const overrides = env.RATE_LIMIT_OVERRIDES 
    ? JSON.parse(env.RATE_LIMIT_OVERRIDES)[routeType] 
    : {};

  const finalOptions = {
    ...baseOptions,
    ...overrides,
  };

  // Cache the computed options
  optionsCache.set(routeType, finalOptions);
  return finalOptions;
};

export const createRateLimiter = (routeType) => {
  if (!Object.values(RouteType).includes(routeType)) {
    logger.error(`Invalid route type: ${routeType}`);
    throw new Error('Invalid route type');
  }

  const options = getRateLimitOptions(routeType);

  return rateLimit({
    ...options,
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    keyGenerator: (req) => `${req.ip}-${routeType}`,
    handler: (req, res, next) => {
      logger.warn(`Rate limit exceeded: ${routeType} - ${req.ip}`);
      next(new Error(options.message));
    },
    // Add skip function to ignore certain requests based on conditions
    skip: (req) => {
      // Skip health check endpoints
      if (req.path === '/health') return true;
      // Skip options requests
      if (req.method === 'OPTIONS') return true;
      return false;
    },
    // Customize request handling
    requestWasSuccessful: (req, res) => {
      return res.statusCode < 400; // Consider only responses with status < 400 as successful
    },
  });
};
