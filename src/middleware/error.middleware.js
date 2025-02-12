// src/middleware/error.middleware.js
import { env } from '../config/env.config.js';
import logger from './logger.middleware.js';
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

/**
 * Format a single error into a standard structure.
 */
const formatError = (err) => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let details = null;
  let stack = env.NODE_ENV === 'development' ? err.stack : undefined;

  // Handle Zod validation errors.
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
  // Handle custom AppErrors.
  else if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details || null;
  }
  // Handle JWT errors.
  else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid Token';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token Expired';
  }
  // Fallback for any other error.
  else {
    message = err.message || message;
  }

  return { statusCode, message, details, stack };
};

/**
 * Error handler middleware.
 * Supports multiple errors if an array or if err.errors is an array.
 */
const errorHandler = (err, req, res, _next) => {
  // Normalize errors: if an array of errors is provided or if the error object has an errors array.
  let errors = [];
  if (Array.isArray(err)) {
    errors = err;
  } else if (err.errors && Array.isArray(err.errors)) {
    errors = err.errors;
  } else {
    errors.push(err);
  }

  // Format each error and add request info.
  const formattedErrors = errors.map(singleError => {
    const formatted = formatError(singleError);
    return {
      ...formatted,
      path: req.path,
      method: req.method,
    };
  });

  // Determine the overall status code.
  const overallStatusCode = formattedErrors.reduce((acc, curr) => Math.max(acc, curr.statusCode), 0);

  // Log each error.
  formattedErrors.forEach(errorItem => {
    if (errorItem.statusCode >= 500) {
      logger.error(errorItem);
    } else {
      logger.warn(errorItem);
    }
  });

  // Respond with a single error object or an array of errors.
  if (formattedErrors.length === 1) {
    const { statusCode, message, details, stack } = formattedErrors[0];
    return res.status(statusCode).json({
      success: false,
      error: {
        message,
        ...(details && { details }),
        ...(env.NODE_ENV === 'development' && { stack }),
      },
    });
  } else {
    return res.status(overallStatusCode).json({
      success: false,
      errors: formattedErrors.map(({ statusCode, message, details, stack }) => ({
        message,
        ...(details && { details }),
        ...(env.NODE_ENV === 'development' && { stack }),
      })),
    });
  }
};

export { errorHandler, AppError };
