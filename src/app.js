import express from 'express';
import passport from 'passport';
import configurePassport from './config/passport.config.js';
import cors from 'cors';
import corsOptions from './config/cors.config.js';
import { errorHandler } from './middleware/error.middleware.js';
import { publicLimiter, authLimiter, apiLimiter } from './middleware/rate-limiter.middleware.js';
import { connectDatabase } from './prisma/prisma.client.js';
// import { fileScanner } from './middleware/file-scanner.middleware.js';


// Routes imports
import authRoutes from './routes/auth.routes.js';
// import productRoutes from './routes/product.routes.js';
// import orderRoutes from './routes/order.routes.js';
// import chatRoutes from './routes/chat.routes.js';
// import customRequestRoutes from './routes/custom-request.routes.js';
// import discountRoutes from './routes/discount.routes.js';
// import adminRoutes from './routes/admin.routes.js';

const app = express();

// Pre-configure passport before middleware setup
configurePassport();

// Essential middleware only
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cors(corsOptions));
app.use(passport.initialize());

// Security middleware
app.use(publicLimiter);
// app.use(fileScanner);

// Health check endpoint
app.get('/health', (req, res) => res.status(200).json({ 
  status: 'ok',
  timestamp: new Date().toISOString()
}));

// API routes with specific rate limits
app.use('/api/auth', authRoutes);
// app.use('/api/products', apiLimiter, productRoutes);
// app.use('/api/orders', apiLimiter, orderRoutes);
// app.use('/api/chat', apiLimiter, chatRoutes);
// app.use('/api/custom-requests', apiLimiter, customRequestRoutes);
// app.use('/api/discounts', apiLimiter, discountRoutes);

// Admin routes with stricter rate limits
// app.use('/api/admin', authLimiter, adminRoutes);

// Error handling
app.use(errorHandler);

export default app;
