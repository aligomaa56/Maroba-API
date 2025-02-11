import { AppError } from '../utils/appError.js';

/**
 * Middleware factory that returns a middleware function
 * to allow access only to users with one of the allowed roles.
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError(401, 'Not authenticated'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError(403, 'You do not have permission to perform this action'));
    }
    next();
  };
};

module.exports = { authorize };
