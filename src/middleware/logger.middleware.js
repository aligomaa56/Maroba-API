import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { env } from '../config/env.config.js';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} - ${level.toUpperCase()} - ${stack || message}`;
});

// File transports only in non-production
const errorTransport = new DailyRotateFile({
  level: 'error',
  filename: 'logs/error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
});

const combinedTransport = new DailyRotateFile({
  filename: 'logs/combined-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
});

// Transports configuration
const transports = [
  // Add file transports only if not in production
  ...(env.NODE_ENV !== 'production' ? [errorTransport, combinedTransport] : []),
  // Console transport always enabled
  new winston.transports.Console({
    format: combine(
      colorize(),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      errors({ stack: true }), // Include stack traces for errors
      logFormat
    ),
  }),
];

// Main logger instance
const logger = winston.createLogger({
  level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logFormat
  ),
  transports,
  // Exception and rejection handlers only in non-production
  exceptionHandlers: env.NODE_ENV !== 'production' ? [
    new winston.transports.File({ filename: 'logs/exceptions.log' }),
  ] : [],
  rejectionHandlers: env.NODE_ENV !== 'production' ? [
    new winston.transports.File({ filename: 'logs/rejections.log' }),
  ] : [],
});

// Handle uncaught exceptions and rejections
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  process.exit(1);
});

export default logger;