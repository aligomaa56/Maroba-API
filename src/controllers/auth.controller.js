import { authService } from '../services/auth.service.js';
import catchAsync from '../utils/catchAsync.js';
import { AppError } from '../middleware/error.middleware.js';
// import passport from 'passport';
// import logger from '../middleware/logger.middleware.js';


export const login = catchAsync(async (req, res, next) => {
  const { identifier, password } = req.body;
  
  if (!identifier || !password) {
    return next(new AppError(400, 'Both identifier and password are required'));
  }
  
  const tokens = await authService.login(identifier, password, req.ip);
  res.status(200).json({ success: true, ...tokens });
});

export const register = catchAsync(async (req, res, next) => {
  const { email, username, password } = req.body;
  
  if (!email || !username || !password) {
    return next(new AppError(400, 'Email, username, and password are required'));
  }
  
  const newUser = await authService.register(email, username, password, req);
  res.status(201).json({
    success: true,
    message: `A link has been sent to verify your identity. Please check your email to complete the registration process.`,
    data: { user: newUser },
  });
});

export const logout = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return next(new AppError(400, 'Refresh token is required'));
  }
  
  await authService.logout(refreshToken);
  res.status(200).json({ success: true, message: 'Logged out successfully' });
});

export const refreshToken = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return next(new AppError(400, 'Refresh token is required'));
  }
  
  const tokens = await authService.refreshToken(refreshToken);
  res.status(200).json({ success: true, ...tokens });
});

export const forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  
  if (!email) {
    return next(new AppError(400, 'Email is required'));
  }
  
  await authService.forgotPassword(email, req);
  res.status(200).json({
    success: true,
    message:
      'If that email address is registered, a password reset email has been sent.',
  });
});

export const resetPassword = catchAsync(async (req, res, next) => {
  const { token } = req.query;
  const { newPassword, confirmPassword } = req.body;
  
  if (!token) {
    return next(new AppError(400, 'Reset token is required'));
  }
  if (!newPassword || !confirmPassword) {
    return next(new AppError(400, 'Both password fields are required'));
  }
  if (newPassword !== confirmPassword) {
    return next(new AppError(400, 'Passwords do not match'));
  }

  await authService.resetPassword(token, newPassword);
  res.status(200).json({ success: true, message: 'Password has been reset' });
});

export const updatePassword = catchAsync(async (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) {
    return next(new AppError(401, 'Not authenticated'));
  }
  
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return next(new AppError(400, 'Current password and new password are required'));
  }
  
  await authService.updatePassword(userId, currentPassword, newPassword);
  res.status(200).json({ success: true, message: 'Password updated successfully' });
});

export const verifyEmail = catchAsync(async (req, res, next) => {
  const token = Array.isArray(req.query.token)
    ? req.query.token[0]
    : req.query.token;

  if (!token) {
    return next(new AppError(400, 'Verification token is required'));
  }
  
  const result = await authService.verifyEmail(token);
  res.status(200).json({
    success: true,
    message: 'Email verified successfully',
    data: {
      user: result.user,
      tokens: result.tokens,
    },
  });
});

// export const googleAuth = catchAsync(async (req, res, next) => {
//   // Validate and sanitize redirectUrl
//   let redirectUrl = req.query.redirect || '';
  
//   // Only allow relative URLs or URLs to trusted domains
//   if (redirectUrl && !redirectUrl.startsWith('/') && !redirectUrl.startsWith(process.env.FRONTEND_URL)) {
//     logger.warn(`Suspicious redirect URL blocked: ${redirectUrl}`);
//     redirectUrl = '/';
//   }
  
//   passport.authenticate('google', {
//     session: false,
//     state: JSON.stringify({ redirectUrl })
//   })(req, res, next);
// });

// export const googleAuthCallback = catchAsync(async (req, res, next) => {
//   passport.authenticate('google', { session: false }, async (error, user) => {
//     if (error || !user) {
//       logger.error('Google authentication failed:', error);
//       const state = JSON.parse(req.query.state || '{}');
//       const redirectUrl = state.redirectUrl || '/api/auth/login';
//       return res.redirect(`${redirectUrl}?error=authentication_failed`);
//     }

//     const tokens = await authService.generateTokens(user.id, user.role);
    
//     // Parse state with error handling
//     let redirectUrl = '/';
//     try {
//       const state = JSON.parse(req.query.state || '{}');
//       redirectUrl = state.redirectUrl || process.env.FRONTEND_URL || '/';
      
//       // Additional security check
//       if (!redirectUrl.startsWith('/') && !redirectUrl.startsWith(process.env.FRONTEND_URL)) {
//         logger.warn(`Suspicious redirect URL blocked: ${redirectUrl}`);
//         redirectUrl = process.env.FRONTEND_URL || '/';
//       }
//     } catch (e) {
//       logger.error('Error parsing state:', e);
//     }

//     // URI encode tokens for safety
//     const encodedAccessToken = encodeURIComponent(tokens.accessToken);
//     const encodedRefreshToken = encodeURIComponent(tokens.refreshToken);
    
//     res.redirect(`${redirectUrl}?access_token=${encodedAccessToken}&refresh_token=${encodedRefreshToken}`);
//   })(req, res, next);
// });
