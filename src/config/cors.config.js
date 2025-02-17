import { env } from './env.config.js';

const whitelist = [
  env.BACKEND_URL,
  env.BASE_URL,
  // env.CLIENT_URL,
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, postman)
    if (!origin) {
      return callback(null, true);
    }

    if (env.NODE_ENV === 'development') {
      return callback(null, true);
    }

    if (whitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true, // Allow credentials (cookies, authorization headers, etc.)
  maxAge: 86400, // Cache preflight requests for 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

export default corsOptions;
