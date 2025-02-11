import dotenv from 'dotenv';

dotenv.config();

export const env = {
  // General config
  APP_NAME: process.env.APP_NAME || 'Maroba API',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 3000,

  // Database
  POSTGRESQL_URI: process.env.POSTGRESQL_URI,
  MONGODB_URI: process.env.MONGODB_URI,

  // CORS URLs
  // CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',

  // Redis
  REDIS_URL: process.env.REDIS_URL || '',
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
  REDIS_TLS: process.env.REDIS_TLS || 'false',

  // Cache
  CACHE_TTL: parseInt(process.env.CACHE_TTL || '300', 10),

  // Rate Limiting
  RATE_LIMIT_OVERRIDES: process.env.RATE_LIMIT_OVERRIDES || '',

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',

  // JWT
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '1h',
  REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY || '7d',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || '',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || '',

  // For production (Gmail)
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,

  // For development (Mailosaur)
  MAILOSAUR_SMTP_HOST: process.env.MAILOSAUR_SMTP_HOST,
  MAILOSAUR_SMTP_PORT: parseInt(process.env.MAILOSAUR_SMTP_PORT || '25', 10),
  MAILOSAUR_SMTP_SECURE: process.env.MAILOSAUR_SMTP_SECURE === 'true',
  MAILOSAUR_USER: process.env.MAILOSAUR_USER,
  MAILOSAUR_PASSWORD: process.env.MAILOSAUR_PASSWORD,
  MAILOSAUR_SENDER_EMAIL: process.env.MAILOSAUR_SENDER_EMAIL,

  // Google OAuth2
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET
};
