import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma/prisma.client.js';
import { AppError } from '../middleware/error.middleware.js';
import { notificationService } from './notification.service.js';
import crypto from 'crypto';
import { UserRole } from '../utils/constants.js';
import logger from '../middleware/logger.middleware.js';
import { parseExpiration } from '../utils/parseExpiration.js';
import { hashPassword } from '../utils/hashPassword.js';

// import { OAuth2Client } from 'google-auth-library';

const PASSWORD_RESET_EXPIRES_IN = 60 * 60 * 1000;
const EMAIL_VERIFICATION_EXPIRES_IN = 24 * 60 * 60 * 1000;

const parsedJwtExpiration = parseExpiration(process.env.JWT_EXPIRES_IN);
const parsedRefreshExpiration = parseExpiration(
  process.env.REFRESH_TOKEN_EXPIRY
);

class AuthService {

  async register(email, username, password, req) {
    // Add input validation
    if (!email || !username || !password) {
      logger.warn('Registration attempted with missing data');
      throw new AppError(400, 'Email, username, and password are required');
    }

    if (password.length < 8) {
      logger.warn('Registration attempted with weak password');
      throw new AppError(400, 'Password must be at least 8 characters long');
    }

    logger.info(`Attempting registration for email: ${email}`);

    // Check if a user with the same email or username exists.
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });

    if (existingUser) {
      logger.warn(`Registration failed: Email or username already taken`);
      throw new AppError(
        400,
        'Registration failed: Email or username already taken'
      );
    }

    // Hash the password.
    const hashedPassword = await hashPassword(password);

    // Generate a verification token.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    // Create the user with default properties.
    const newUser = await prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
        failedLoginAttempts: 0,
        accountLockedUntil: null,
        isVerified: false,
        role: UserRole.USER,
        verificationToken: hashedToken,
        verificationTokenExpires: new Date(
          Date.now() + EMAIL_VERIFICATION_EXPIRES_IN
        ),
      },
    });

    // Send verification email with the raw (unencrypted) token.
    await notificationService.sendVerificationNotification(
      email,
      rawToken,
      req
    );

    logger.info(`User registered successfully: ${email}`);
    return { id: newUser.id, email: newUser.email, username: newUser.username };
  }

  async login(identifier, password, ip) {
    if (!identifier || !password) {
      logger.warn(`Login attempt with missing credentials from IP: ${ip}`);
      throw new AppError(400, 'Both identifier and password are required');
    }

    logger.info(`Login attempt for identifier: ${identifier} from IP: ${ip}`);

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: identifier }, { username: identifier }],
      },
      select: {
        id: true,
        password: true,
        failedLoginAttempts: true,
        accountLockedUntil: true,
        isVerified: true,
        role: true,
        email: true,
        username: true,
      },
    });

    try {
      this.validateLoginAttempt(user, ip);
      await this.verifyPassword(user.password, password);

      // *** Single Session Enforcement ***
      // Check if the user already has an active session.
      const activeSession = await prisma.refreshToken.findFirst({
        where: {
          userId: user.id,
          expiresAt: { gt: new Date() },
        },
      });
      if (activeSession) {
        throw new AppError(
          403,
          'User already logged in from another session. Please log out first.'
        );
      }

      await this.resetFailedAttempts(user.id);
      const tokens = await this.generateTokens(user.id, user.role);
      logger.info(`Login successful for user: ${user.email}`);
      return tokens;
    } catch (error) {
      if (user) {
        await this.handleFailedLoginAttempt(user.id, user.failedLoginAttempts);
      }
      throw error;
    }
  }

  async verifyEmail(token) {
    if (!token || typeof token !== 'string' || token.length < 32) {
      logger.warn('Email verification attempted with invalid token format');
      throw new AppError(400, 'Invalid verification token format');
    }

    logger.info('Processing email verification');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    try {
      const result = await prisma.$transaction(async (prisma) => {
        // First find the user with minimal fields
        const user = await prisma.user.findFirst({
          where: {
            verificationToken: hashedToken,
            verificationTokenExpires: { gt: new Date() },
            isVerified: false,
          },
          select: { id: true, email: true, role: true }
        });

        if (!user) {
          logger.warn('Invalid or expired verification token attempted');
          throw new AppError(400, 'Invalid or expired verification token');
        }

        // Update with minimal return fields
        await prisma.user.update({
          where: { id: user.id },
          data: {
            isVerified: true,
            verificationToken: null,
            verificationTokenExpires: null
          }
        });

        // Generate tokens
        const tokens = await this.generateTokens(user.id, user.role);
        logger.info(`Email verified successfully for user: ${user.email}`);
        
        // Return minimal data
        return {
          user: { id: user.id, email: user.email },
          tokens
        };
      }, {
        timeout: 10000,
        maxWait: 5000,
        isolationLevel: 'ReadCommitted'
      });

      // Return the result directly without wrapping
      return result;
    } catch (error) {
      if (error.code === 'P2025') {
        logger.warn('Invalid or expired verification token attempted');
        throw new AppError(400, 'Invalid or expired verification token');
      }
      if (error instanceof AppError) throw error;
      
      logger.error('Email verification failed:', error);
      throw new AppError(500, 'Failed to verify email');
    }
  }

  async logout(refreshToken) {
    logger.info('Attempting to logout with refresh token');
    try {
      // Use delete instead of transaction since we only need one operation
      await prisma.refreshToken.delete({
        where: { token: refreshToken }
      });
      logger.info('Refresh token successfully deleted for logout');
    } catch (error) {
      if (error.code === 'P2025') {
        logger.warn('Invalid refresh token provided for logout');
        throw new AppError(400, 'Invalid refresh token');
      }
      throw error;
    }
  }

  async refreshToken(refreshToken) {
    if (!refreshToken || typeof refreshToken !== 'string') {
      logger.warn('Token refresh attempted with invalid token format');
      throw new AppError(400, 'Invalid refresh token format');
    }

    let decoded;
    try {
      // First verify the JWT signature
      decoded = await jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

      // Find and delete the old refresh token in one operation
      const oldToken = await prisma.refreshToken.delete({
        where: { 
          token: refreshToken,
          userId: decoded.userId,
          expiresAt: { gt: new Date() }
        },
        select: { userId: true }
      });

      if (!oldToken) {
        logger.warn(`Invalid or expired refresh token used for user: ${decoded.userId}`);
        // Clean up any other tokens for this user as security measure
        await prisma.refreshToken.deleteMany({
          where: { userId: decoded.userId }
        });
        throw new AppError(401, 'Invalid or expired refresh token');
      }

      // Generate new tokens
      const tokens = await this.generateTokens(decoded.userId, decoded.role);
      logger.info(`Tokens refreshed successfully for user: ${decoded.userId}`);
      
      return tokens;
    } catch (error) {
      if (error instanceof AppError) throw error;
      
      if (error.name === 'TokenExpiredError') {
        logger.warn(`Expired refresh token used: ${error.message}`);
        // Clean up expired token
        await prisma.refreshToken.deleteMany({
          where: { token: refreshToken }
        });
        throw new AppError(401, 'Refresh token has expired');
      }

      if (error.name === 'JsonWebTokenError') {
        logger.warn(`Invalid refresh token signature: ${error.message}`);
        throw new AppError(401, 'Invalid refresh token');
      }

      logger.error('Refresh token verification failed:', error);
      throw new AppError(500, 'Failed to refresh tokens');
    }
  }

  async forgotPassword(email, req) {
    if (!email) {
      throw new AppError(400, 'Email is required');
    }

    logger.info(`Password reset requested for email: ${email}`);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      logger.warn(`Password reset requested for non-existing email: ${email}`);
      return; // Do not reveal whether the email exists
    }

    // *** Rate Limiting Password Resets ***
    // If a reset token is already active, do not issue another one.
    if (user.resetPasswordToken && user.resetPasswordExpire > new Date()) {
      logger.warn(`Password reset already requested for email: ${email}`);
      return;
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const expires = new Date(Date.now() + PASSWORD_RESET_EXPIRES_IN);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: hashedToken,
        resetPasswordExpire: expires,
      },
    });

    await notificationService.sendPasswordResetNotification(
      email,
      rawToken,
      req
    );
    logger.info(`Password reset token sent to email: ${email}`);
  }

  async resetPassword(token, newPassword) {
    // Add password validation
    if (!token || !newPassword) {
      logger.warn('Password reset attempted with missing data');
      throw new AppError(400, 'Token and new password are required');
    }

    if (newPassword.length < 8) {
      logger.warn('Password reset attempted with weak password');
      throw new AppError(400, 'New password must be at least 8 characters long');
    }

    logger.info('Processing password reset request');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    try {
      // First find the user and hash the password independently
      const [hashedPassword, existingUser] = await Promise.all([
        hashPassword(newPassword),
        prisma.user.findFirst({
          where: {
            resetPasswordToken: hashedToken,
            resetPasswordExpire: { gt: new Date() }
          }
        })
      ]);

      if (!existingUser) {
        logger.warn('Invalid or expired reset token used');
        throw new AppError(400, 'Invalid or expired reset token');
      }

      // Then update the user with the hashed password
      const updatedUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          password: hashedPassword,
          resetPasswordToken: null,
          resetPasswordExpire: null,
          failedLoginAttempts: 0,
          accountLockedUntil: null
        }
      });

      logger.info(`Password reset successful for user: ${updatedUser.email}`);
      return updatedUser;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Password reset failed:', error);
      throw new AppError(500, 'Failed to reset password');
    }
  }

  async updatePassword(userId, currentPassword, newPassword) {
    // Add comprehensive password validation
    if (!userId || !currentPassword || !newPassword) {
      logger.warn('Password update attempted with missing data');
      throw new AppError(400, 'All fields are required');
    }

    if (currentPassword === newPassword) {
      logger.warn('Password update attempted with same password');
      throw new AppError(400, 'New password must be different from current password');
    }

    if (newPassword.length < 8) {
      logger.warn('Password update attempted with weak password');
      throw new AppError(400, 'New password must be at least 8 characters long');
    }

    logger.info(`Updating password for user: ${userId}`);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });

    if (!user) {
      logger.warn(`User not found for password update: ${userId}`);
      throw new AppError(404, 'User not found');
    }

    await this.verifyPassword(user.password, currentPassword);

    const hashedPassword = await hashPassword(newPassword);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      }),
      prisma.refreshToken.deleteMany({ where: { userId } }),
    ]);

    logger.info(`Password updated successfully for user: ${userId}`);
  }

  // Clean up expired refresh tokens. (Scheduled task)
  async cleanExpiredTokens() {
    const now = new Date();
    const batchSize = 100;
    let deleted = 0;

    try {
      // Get expired tokens in batches
      const expiredTokens = await prisma.refreshToken.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        take: batchSize
      });

      if (expiredTokens.length > 0) {
        // Delete in batch but with better error handling
        await prisma.refreshToken.deleteMany({
          where: {
            id: { in: expiredTokens.map(token => token.id) }
          }
        });
        deleted = expiredTokens.length;
      }

      logger.info(`Cleaned ${deleted} expired refresh tokens`);
    } catch (error) {
      logger.error('Failed to clean expired tokens:', error);
      // Don't throw as this is a background task
    }
  }

  // async handleGoogleLogin(profile) {
  //   if (!profile || !profile.emails || !profile.emails[0]) {
  //     throw new AppError(400, 'Invalid Google profile data');
  //   }

  //   const { id: googleId, displayName, emails, name } = profile;
  //   const email = emails[0].value;
  //   const firstName = name?.givenName || '';
  //   const lastName = name?.familyName || '';

  //   let user = await prisma.user.findUnique({ where: { email } });

  //   if (user) {
  //     if (!user.isGoogleUser) {
  //       user = await prisma.user.update({
  //         where: { id: user.id },
  //         data: {
  //           googleId,
  //           isGoogleUser: true,
  //           isVerified: true,
  //         },
  //       });
  //     }
  //   } else {
  //     const username = email.split('@')[0];
  //     const randomPassword = crypto.randomBytes(16).toString('hex');
  //     const hashedPassword = await hashPassword(randomPassword);

  //     user = await prisma.user.create({
  //       data: {
  //         email,
  //         username,
  //         firstName,
  //         lastName,
  //         password: hashedPassword,
  //         googleId,
  //         isGoogleUser: true,
  //         isVerified: true,
  //         role: UserRole.USER,
  //       },
  //     });
  //   }

  //   logger.info(`Google authentication successful for user: ${user.email}`);
  //   return user;
  // }



  async generateTokens(userId, role) {
    // Add validation for required parameters
    if (!userId || !role) {
      logger.error('Token generation attempted without required parameters');
      throw new AppError(400, 'User ID and role are required for token generation');
    }

    logger.info(`Generating tokens for user: ${userId}`);
    try {
      // Generate both tokens in parallel for better performance
      const jti = crypto.randomUUID();
      const [accessToken, refreshToken] = await Promise.all([
        jwt.sign(
          { userId, role, jti },
          process.env.JWT_ACCESS_SECRET,
          { expiresIn: parsedJwtExpiration }
        ),
        jwt.sign(
          { userId, role, jti },
          process.env.JWT_REFRESH_SECRET,
          { expiresIn: parsedRefreshExpiration }
        )
      ]);

      const expiresAt = new Date(Date.now() + parsedRefreshExpiration);

      // Store refresh token with error handling
      try {
        await prisma.refreshToken.create({
          data: { token: refreshToken, userId, expiresAt }
        });
      } catch (error) {
        logger.error(`Failed to store refresh token for user ${userId}:`, error);
        throw new AppError(500, 'Failed to complete authentication process');
      }

      logger.debug(`Tokens generated successfully for user: ${userId}`);
      return { accessToken, refreshToken };
    } catch (error) {
      logger.error(`Token generation failed for user ${userId}:`, error);
      throw new AppError(500, 'Failed to generate authentication tokens');
    }
  }

  async verifyPassword(hashedPassword, candidatePassword) {
    if (!hashedPassword || !candidatePassword) {
      logger.warn('Password verification attempted with missing data');
      throw new AppError(400, 'Password verification failed: Missing data');
    }

    if (typeof hashedPassword !== 'string' || typeof candidatePassword !== 'string') {
      logger.warn('Password verification attempted with invalid data types');
      throw new AppError(400, 'Invalid password format');
    }

    const isMatch = await bcrypt.compare(candidatePassword, hashedPassword);
    if (!isMatch) {
      logger.warn('Password verification failed');
      throw new AppError(401, 'Invalid credentials');
    }
  }

  validateLoginAttempt(user, ip) {
    // Add IP validation
    if (!ip) {
      logger.warn('Login attempt validation without IP address');
      throw new AppError(400, 'IP address is required');
    }

    if (!user) {
      logger.warn(`Invalid credentials from IP: ${ip}`);
      throw new AppError(401, 'Invalid credentials');
    }

    if (user.accountLockedUntil?.getTime() > Date.now()) {
      const timeLeft = Math.ceil(
        (user.accountLockedUntil.getTime() - Date.now()) / 1000 / 60
      );
      logger.warn(
        `Locked account login attempt (${user.email}) from IP: ${ip}. Time remaining: ${timeLeft} minutes`
      );
      throw new AppError(
        403,
        `Account temporarily locked. Try again in ${timeLeft} minutes`
      );
    }

    if (!user.isVerified) {
      logger.warn(`Unverified login attempt (${user.email}) from IP: ${ip}`);
      throw new AppError(403, 'Please verify your email first');
    }
  }

  async handleFailedLoginAttempt(userId, currentAttempts) {
    // Add validation for required parameters
    if (!userId || typeof currentAttempts !== 'number') {
      logger.warn('Failed login handling attempted with invalid parameters');
      return;
    }

    try {
      const attempts = currentAttempts + 1;
      const lockDuration = this.calculateLockDuration(attempts);

      await prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginAttempts: attempts,
          accountLockedUntil: lockDuration,
        }
      });

      if (lockDuration) {
        logger.warn(`Account locked for user ${userId}. Attempts: ${attempts}`);
      } else {
        logger.warn(`Failed login attempt for user ${userId}. Attempts: ${attempts}`);
      }
    } catch (error) {
      logger.error(`Failed to update login attempts for user ${userId}:`, error);
      // Don't throw - this is a background operation
    }
  }

  calculateLockDuration(attempts) {
    // Add validation for attempts parameter
    if (typeof attempts !== 'number' || attempts < 0) {
      logger.warn('Lock duration calculation attempted with invalid attempts count');
      return null;
    }

    if (attempts >= 5) {
      return new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    }
    return null;
  }

  async resetFailedAttempts(userId) {
    if (!userId) return;

    await prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: 0,
        accountLockedUntil: null,
      },
    });
  }
}

export const authService = new AuthService();
