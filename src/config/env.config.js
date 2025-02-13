import dotenv from 'dotenv';

dotenv.config();

export const env = {
  // General config
  APP_NAME: process.env.APP_NAME,
  BASE_URL: process.env.BASE_URL,
  BACKEND_URL: process.env.BACKEND_URL,
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT || 3000,

  // PostgreSQL
  DATABASE_URL: process.env.DATABASE_URL,

  // JWT
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,

  // For production (Gmail)
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,

  // For development (Mailosaur)
  MAILOSAUR_SMTP_HOST: process.env.MAILOSAUR_SMTP_HOST,
  MAILOSAUR_SMTP_PORT: parseInt(process.env.MAILOSAUR_SMTP_PORT),
  MAILOSAUR_SMTP_SECURE: process.env.MAILOSAUR_SMTP_SECURE,
  MAILOSAUR_USER: process.env.MAILOSAUR_USER,
  MAILOSAUR_PASSWORD: process.env.MAILOSAUR_PASSWORD,
  MAILOSAUR_SENDER_EMAIL: process.env.MAILOSAUR_SENDER_EMAIL,

  // Rate Limiting
  RATE_LIMIT_OVERRIDES: process.env.RATE_LIMIT_OVERRIDES,

  // Google OAuth2
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET
};
