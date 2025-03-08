import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma/prisma.client.js';
import { AppError } from '../middleware/error.middleware.js';
import notificationService from './notification.service.js';
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

  async generateAndStoreTokens(userId, role) {
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
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId,
        expiresAt
      }
    });

    return { accessToken, refreshToken };
  }

  async deleteUserRefreshTokens(userId) {
    await prisma.refreshToken.deleteMany({
      where: { userId }
    });
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

      // Delete any existing sessions before creating new one
      await this.deleteUserRefreshTokens(user.id);
      
      await this.resetFailedAttempts(user.id);
      const tokens = await this.generateAndStoreTokens(user.id, user.role);
      
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

        await prisma.user.update({
          where: { id: user.id },
          data: {
            isVerified: true,
            verificationToken: null,
            verificationTokenExpires: null
          }
        });

        const tokens = await this.generateAndStoreTokens(user.id, user.role);
        
        return {
          user: { id: user.id, email: user.email },
          tokens
        };
      });

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
    // Delete refresh token in a transaction
    await prisma.$transaction(async (prisma) => {
      const token = await prisma.refreshToken.findUnique({
        where: { token: refreshToken }
      });

      if (!token) {
        logger.warn('Invalid refresh token provided for logout');
        throw new AppError(400, 'Invalid refresh token');
      }

      await prisma.refreshToken.delete({
        where: { token: refreshToken }
      });
      logger.info('Refresh token successfully deleted for logout');
    });
  }

  async refreshToken(refreshToken) {
    if (!refreshToken || typeof refreshToken !== 'string') {
      logger.warn('Token refresh attempted with invalid token format');
      throw new AppError(400, 'Invalid refresh token format');
    }

    let decoded;
    try {
      const [decodedToken, storedToken] = await Promise.all([
        jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET),
        prisma.refreshToken.findFirst({
          where: { token: refreshToken },
          select: { expiresAt: true, userId: true, token: true }
        })
      ]);
      decoded = decodedToken;

      if (!storedToken) {
        logger.warn(`Refresh token not found in database for user: ${decoded.userId}`);
        throw new AppError(401, 'Invalid refresh token');
      }

      // Check expiration using timestamp comparison
      if (storedToken.expiresAt.getTime() < Date.now()) {
        // Delete expired token
        await this.deleteUserRefreshTokens(storedToken.userId);
        logger.warn(`Expired refresh token used for user: ${decoded.userId}`);
        throw new AppError(401, 'Refresh token has expired');
      }

      const result = await prisma.$transaction(async (prisma) => {
        await this.deleteUserRefreshTokens(storedToken.userId);
        return this.generateAndStoreTokens(decoded.userId, decoded.role);
      });

      logger.info(`Tokens refreshed successfully for user: ${decoded.userId}`);
      return result;

    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        logger.warn('Invalid refresh token signature');
        throw new AppError(401, 'Invalid refresh token');
      }
      if (error instanceof AppError) throw error;
      
      logger.error('Refresh token process failed:', error);
      throw new AppError(500, 'Failed to refresh tokens');
    }
  }

  async forgotPassword(email, req) {
    if (!email) {
      logger.warn('Password reset requested without email');
      throw new AppError(400, 'Email is required');
    }

    logger.info(`Password reset requested for email: ${email}`);
    
    try {
      const result = await prisma.$transaction(async (prisma) => {
        const user = await prisma.user.findUnique({ 
          where: { email },
          select: {
            id: true,
            email: true,
            failedLoginAttempts: true,  // Using existing field for rate limiting
            accountLockedUntil: true,   // Using existing field for lockout
            resetPasswordExpire: true   // Check existing reset token expiry
          }
        });

        if (!user) {
          logger.warn(`Password reset requested for non-existing email: ${email}`);
          return; // Don't reveal if email exists
        }

        // Check rate limiting
        const now = new Date();
        const hourAgo = new Date(now - 3600000); // 1 hour ago

        if (user.accountLockedUntil && user.accountLockedUntil > now) {
          logger.warn(`Account locked for password reset: ${email}`);
          throw new AppError(429, 'Too many reset attempts. Please try again later.');
        }

        // Use failedLoginAttempts as our attempt counter
        if (user.failedLoginAttempts >= 3 && user.resetPasswordExpire > hourAgo) {
          // Lock the account for password resets
          await prisma.user.update({
            where: { id: user.id },
            data: {
              accountLockedUntil: new Date(Date.now() + 3600000) // Lock for 1 hour
            }
          });
          logger.warn(`Too many password reset attempts for email: ${email}`);
          throw new AppError(429, 'Too many reset attempts. Please try again in 1 hour.');
        }

        // Generate new token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto
          .createHash('sha256')
          .update(rawToken)
          .digest('hex');
        const expires = new Date(Date.now() + PASSWORD_RESET_EXPIRES_IN);

        // Update user with new token and track attempts
        await prisma.user.update({
          where: { id: user.id },
          data: {
            resetPasswordToken: hashedToken,
            resetPasswordExpire: expires,
            failedLoginAttempts: user.resetPasswordExpire > hourAgo 
              ? user.failedLoginAttempts + 1 
              : 1
          }
        });

        return { email: user.email, rawToken };
      });

      if (result) {
        await notificationService.sendPasswordResetNotification(
          result.email,
          result.rawToken,
          req
        );
        logger.info(`Password reset token sent to email: ${result.email}`);
      }

      // Always return success to prevent email enumeration
      return { message: 'If the email exists, a password reset link will be sent.' };

    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Password reset process failed:', error);
      throw new AppError(500, 'Failed to process password reset request');
    }
  }

  async resetPassword(token, newPassword) {
    // Initial validation
    if (!token || !newPassword) {
      logger.warn('Password reset attempted with missing data');
      throw new AppError(400, 'Token and new password are required');
    }

    if (newPassword.length < 8) {
      logger.warn('Password reset attempted with weak password');
      throw new AppError(400, 'New password must be at least 8 characters long');
    }

    logger.info('Processing password reset request');

    try {
      // Hash the token first
      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

      // Execute the reset in a transaction
      const result = await prisma.$transaction(async (prisma) => {
        // Find user first
        const user = await prisma.user.findFirst({
          where: {
            resetPasswordToken: hashedToken,
            resetPasswordExpire: { gt: new Date() }
          },
          select: {
            id: true,
            email: true
          }
        });

        if (!user) {
          logger.warn('Invalid or expired reset token used');
          throw new AppError(400, 'Invalid or expired reset token');
        }

        // Hash the password after finding the user
        const hashedPassword = await hashPassword(newPassword);

        // Update user with new password and reset token fields
        const updatedUser = await prisma.user.update({
          where: { id: user.id },
          data: {
            password: hashedPassword,
            resetPasswordToken: null,
            resetPasswordExpire: null,
            failedLoginAttempts: 0,
            accountLockedUntil: null
          },
          select: {
            id: true,
            email: true
          }
        });

        // Invalidate all refresh tokens
        await this.deleteUserRefreshTokens(user.id);

        return updatedUser;
      }, {
        timeout: 10000,
        maxWait: 5000,
        isolationLevel: 'ReadCommitted'
      });

      logger.info(`Password reset successful for user: ${result.email}`);
      return result;

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
    
    try {
      const result = await prisma.$transaction(async (prisma) => {
        // Find user and verify current password
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { password: true },
        });

        if (!user) {
          logger.warn(`User not found for password update: ${userId}`);
          throw new AppError(404, 'User not found');
        }

        await this.verifyPassword(user.password, currentPassword);

        // Hash new password
        const hashedPassword = await hashPassword(newPassword);

        // Update password
        await prisma.user.update({
          where: { id: userId },
          data: { password: hashedPassword },
        });

        // Delete all refresh tokens
        await prisma.refreshToken.deleteMany({
          where: { userId }
        });

        return { success: true };
      }, {
        timeout: 10000,
        maxWait: 5000,
        isolationLevel: 'ReadCommitted'
      });

      logger.info(`Password updated successfully for user: ${userId}`);
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Password update failed:', error);
      throw new AppError(500, 'Failed to update password');
    }
  }

  async cleanExpiredTokens() {
    const batchSize = 1000;
    let deleted = 0;
    
    do {
      const result = await prisma.refreshToken.deleteMany({
        where: { 
          expiresAt: { lt: new Date() }
        },
        take: batchSize
      });
      deleted = result.count;
    } while (deleted === batchSize);
  }

  async handleGoogleLogin(profile) {
    if (!profile || !profile.emails || !profile.emails[0]) {
      logger.warn('Invalid Google profile data provided');
      throw new AppError(400, 'Invalid Google profile data');
    }
  
    const { id: googleId, emails, name } = profile;
    const email = emails[0].value;
    const firstName = name?.givenName || '';
    const lastName = name?.familyName || '';
  
    try {
      // Find or create the user in a transaction
      const user = await prisma.$transaction(async (prismaTx) => {
        let user = await prismaTx.user.findUnique({ 
          where: { email },
          select: { 
            id: true, 
            email: true, 
            isGoogleUser: true, 
            role: true,
            googleId: true
          }
        });
  
        if (user) {
          // Update existing user if needed
          if (!user.isGoogleUser || user.googleId !== googleId) {
            user = await prismaTx.user.update({
              where: { id: user.id },
              data: {
                googleId,
                isGoogleUser: true,
                isVerified: true,
              },
              select: { 
                id: true, 
                email: true,
                role: true 
              }
            });
          }
        } else {
          // Create new user
          const username = `${email.split('@')[0]}_${Date.now().toString().slice(-4)}`;
          const randomPassword = crypto.randomBytes(16).toString('hex');
          const hashedPassword = await hashPassword(randomPassword);
  
          user = await prismaTx.user.create({
            data: {
              email,
              username,
              firstName,
              lastName,
              password: hashedPassword,
              googleId,
              isGoogleUser: true,
              isVerified: true,
              failedLoginAttempts: 0,
              accountLockedUntil: null,
              role: UserRole.USER,
            },
            select: { 
              id: true, 
              email: true,
              role: true
            }
          });
        }
  
        return user;
      });
  
      // Enforce single session: Delete any existing refresh tokens for this user
      await this.deleteUserRefreshTokens(user.id);
  
      // Generate new tokens for the session
      const tokens = await this.generateAndStoreTokens(user.id, user.role);
  
      logger.info(`Google authentication successful for user: ${user.email}`);
      return { user, tokens };
    } catch (error) {
      logger.error('Google authentication failed:', error);
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'Failed to authenticate with Google');
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
