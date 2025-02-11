import jwt from 'jsonwebtoken';
import { AppError } from './error.middleware.js';

// Protect middleware: verifies JWT token and attaches user info to req.user.
export const protect = (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(new AppError(401, 'Not authenticated, token missing'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = { id: decoded.userId, role: decoded.role };
    next();
  } catch (error) {
    return next(new AppError(401, 'Not authenticated, token invalid'));
  }
};
