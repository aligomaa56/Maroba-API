import { createRateLimiter, RouteType } from '../config/rate-limit.config.js';
import {AppError} from './error.middleware.js';

function rateLimiter(routeType) {
  const limiter = createRateLimiter(routeType);

  const errorMiddleware = (err, req, res, next) => {
    if (err.message.includes('Too many')) {
      next(new AppError(429, err.message));
      return;
    }
    next(err);
  };

  return [limiter, errorMiddleware];
}

const authLimiter = rateLimiter(RouteType.AUTHENTICATION);
const apiLimiter = rateLimiter(RouteType.API);
const publicLimiter = rateLimiter(RouteType.PUBLIC);

export { rateLimiter, authLimiter, apiLimiter, publicLimiter };
