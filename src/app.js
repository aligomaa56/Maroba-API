// src/app.js - Optimized version with Logging
import express from 'express';
import passport from 'passport';
import configurePassport from './config/passport.config.js';
import cors from 'cors';
import corsOptions from './config/cors.config.js';
import { errorHandler } from './middleware/error.middleware.js';
import { publicLimiter } from './middleware/rate-limiter.middleware.js';
import { connectDatabase } from './prisma/prisma.client.js';
import authRoutes from './routes/auth.routes.js';
import logger from './middleware/logger.middleware.js'; // ✅ Import logger
import { env } from './config/env.config.js';

const app = express();

logger.info('Initializing application...');

configurePassport();
app.use(passport.initialize());

// Enhanced database middleware with logging
app.use(async (req, res, next) => {
  try {
    if (!req.prisma) {
      await connectDatabase();
      req.prisma = prisma;
    }
    logger.info('Database connection verified.');
    next();
  } catch (error) {
    logger.error('Database unavailable:', error);
    next(new AppError(503, 'Database unavailable'));
  }
});

// Security middleware pipeline
const securityMiddlewares = [
  express.json(),
  express.urlencoded({ extended: true }),
  cors(corsOptions),
  publicLimiter,
];

securityMiddlewares.forEach((middleware) => {
  app.use(middleware);
});

app.use((req, res, next) => {
  logger.info(`📡 ${req.method} ${req.url} - IP: ${req.ip}`);
  next();
});

// Health check endpoint with logging
app.get('/health', (req, res) => {
  logger.info('Health check requested.');
  res.status(200).json({
    status: 'ok',
    services: {
      database: 'connected',
      redis: env.REDIS_URL ? 'connected' : 'disabled',
      smtp: 'active',
    },
    timestamp: new Date().toISOString(),
  });
});

const routeConfig = [{ path: '/api/auth', handler: authRoutes }];
routeConfig.forEach(({ path, handler }) => {
  logger.info(`🚀 Mounting route: ${path}`);
  app.use(path, handler);
});

app.use((err, req, res, next) => {
  logger.error(`❌ ${err.statusCode || 500} - ${err.message} - Path: ${req.path}`);
  next(err);
});

app.use(errorHandler);

logger.info('✅ Application initialized successfully.');

export default app;
