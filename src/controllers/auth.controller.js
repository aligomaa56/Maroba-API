import { authService } from '../services/auth.service.js';
import catchAsync from '../utils/catchAsync.js';
import { AppError } from '../middleware/error.middleware.js';

export const login = catchAsync(async (req, res, next) => {
  const { identifier, password } = req.body;
  const tokens = await authService.login(identifier, password, req.ip);
  res.status(200).json({ success: true, ...tokens });
});

export const register = catchAsync(async (req, res, next) => {
  const { email, username, password } = req.body;
  const newUser = await authService.register(email, username, password, req);
  res
    .status(201)
    .json({
      success: true,
      message: `A link has been sent to verify your identity. Please check your email to complete the registration process.`,
      data: { user: newUser },
    });
});

/**
 * POST /api/auth/logout
 * Request Body: { refreshToken: string }
 */
export const logout = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  await authService.logout(refreshToken);
  res.status(200).json({ success: true, message: 'Logged out successfully' });
});

/**
 * POST /api/auth/refresh-token
 * Request Body: { refreshToken: string }
 * Response: { accessToken: string, refreshToken: string }
 */
export const refreshToken = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  const tokens = await authService.refreshToken(refreshToken);
  res.status(200).json({ success: true, ...tokens });
});

export const forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;
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
    throw new AppError(400, 'Reset token is required');
  }
  if (!newPassword || !confirmPassword) {
    throw new AppError(400, 'Both password fields are required');
  }
  if (newPassword !== confirmPassword) {
    throw new AppError(400, 'Passwords do not match');
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
  await authService.updatePassword(userId, currentPassword, newPassword);
  res
    .status(200)
    .json({ success: true, message: 'Password updated successfully' });
});

/**
 * POST /api/auth/google-login
 * Request Body: { idToken: string }
 * Response: { accessToken: string, refreshToken: string }
 */
// export const googleLogin = catchAsync(async (req, res, next) => {
//   const { idToken } = req.body;
//   const tokens = await authService.googleLogin(idToken, req);
//   res.status(200).json({ success: true, ...tokens });
// });

export const googleAuth = catchAsync(async (req, res) => {
  passport.authenticate('google', {
    session: false,
    state: JSON.stringify({ redirectUrl: req.query.redirect })
  })(req, res);
});

export const googleAuthCallback = catchAsync(async (req, res) => {
  passport.authenticate('google', { session: false }, async (error, user) => {
    if (error || !user) {
      const redirectUrl = JSON.parse(req.query.state)?.redirectUrl || '/api/auth/login';
      return res.redirect(`${redirectUrl}?error=authentication_failed`);
    }

    const tokens = await authService.generateTokens(user.id, user.role);
    
    const state = JSON.parse(req.query.state || '{}');
    const redirectUrl = state.redirectUrl || process.env.FRONTEND_URL;

    res.redirect(`${redirectUrl}?access_token=${tokens.accessToken}&refresh_token=${tokens.refreshToken}`);
  })(req, res);
});


export const verifyEmail = catchAsync(async (req, res, next) => {
  const token = Array.isArray(req.query.token)
    ? req.query.token[0]
    : req.query.token;

  if (!token) {
    throw new AppError(400, 'Verification token is required');
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
