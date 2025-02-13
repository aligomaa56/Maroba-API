import jwt from 'jsonwebtoken';
import { AppError } from './error.middleware.js';

// Cache the secret keys at startup
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;

export const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Authentication required'));
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, ACCESS_SECRET);
    req.user = { id: decoded.userId, role: decoded.role };
    next();
  } catch (error) {
    const message = error.name === 'TokenExpiredError' 
      ? 'Session expired' 
      : 'Invalid authentication token';
    next(new AppError(401, message));
  }
};