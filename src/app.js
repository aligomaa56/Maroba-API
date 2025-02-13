import express from 'express';
import passport from 'passport';
import configurePassport from './config/passport.config.js';
import cors from 'cors';
import corsOptions from './config/cors.config.js';
import { errorHandler } from './middleware/error.middleware.js';
import { publicLimiter, authLimiter} from './middleware/rate-limiter.middleware.js';
import { prisma } from './prisma/prisma.client.js';
import authRoutes from './routes/auth.routes.js';
import logger from './middleware/logger.middleware.js';
import { env } from './config/env.config.js';

const app = express();

logger.info('Initializing application...');

// Security middleware pipeline
app.use([
  express.json(),
  express.urlencoded({ extended: true }),
  cors(corsOptions),
  publicLimiter
]);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/auth',authLimiter, authRoutes);

app.use(errorHandler);

logger.info('✅ Application initialized successfully.');

export default app;