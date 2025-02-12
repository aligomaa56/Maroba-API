// src/middleware/auth.middleware.js
import jwt from 'jsonwebtoken';
import { AppError } from './error.middleware.js';
import { CacheService } from '../services/cache.service.js';

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(new AppError(401, 'Not authenticated, token missing'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    // Check if the token has been blacklisted.
    const isBlacklisted = await CacheService.exists(`blacklist:${decoded.jti}`);
    if (isBlacklisted) {
      return next(new AppError(401, 'Token has been revoked'));
    }

    req.user = { id: decoded.userId, role: decoded.role };
    next();
  } catch (error) {
    return next(new AppError(401, 'Not authenticated, token invalid'));
  }
};
