import { env } from '../config/env.config.js';
import logger from './logger.middleware.js';  // Changed to import syntax
import { ZodError } from 'zod';

class AppError extends Error {
  constructor(statusCode, message, isOperational = true, details) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const errorHandler = (err, req, res, _next) => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let details = null;

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    statusCode = 400;
    message = 'Validation Error';
    details = {
      message: 'Validation failed',
      issues: err.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  } 
  // Handle custom AppErrors
  else if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details || null;
  } 
  // Handle MongoDB duplicate key errors
  else if (err.name === 'MongoServerError' && err.code === 11000) {
    statusCode = 409;
    message = 'Duplicate Key Error';
    const key = Object.keys(err.keyValue)[0];
    details = { message: `${key} already exists` };
  } 
  // Handle JWT errors
  else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid Token';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token Expired';
  } 
  // Generic error handling
  else {
    message = err.message || message;
  }

  const logMessage = {
    statusCode,
    message,
    path: req.path,
    method: req.method,
    details,
    stack: env.NODE_ENV === 'development' ? err.stack : undefined,
  };

  if (statusCode >= 500) {
    logger.error(logMessage);
  } else {
    logger.warn(logMessage);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(details && { details }),
      ...(env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
};

export { errorHandler, AppError };
