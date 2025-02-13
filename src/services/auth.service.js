import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma/prisma.client.js';
import { AppError } from '../middleware/error.middleware.js';
import { notificationService } from './notification.service.js';
import crypto from 'crypto';
import { UserRole } from '../utils/constants.js';
import logger from '../middleware/logger.middleware.js';
import { OAuth2Client } from 'google-auth-library';

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';

function parseExpiration(expiration) {
  const units = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const match = expiration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid expiration format: ${expiration}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  return value * units[unit];
}

class AuthService {
  // Register a new user
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
      throw new AppError(400, 'Registration failed');
    }

    // Hash the password.
    const hashedPassword = await bcrypt.hash(password, 12);

    // Generate a verification token.
    // rawToken will be sent to the user; hashedToken is stored in the DB.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

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
        verificationTokenExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // Send verification email with the raw (unencrypted) token.
    await notificationService.sendVerificationNotification(email, rawToken, req);

    logger.info(`User registered successfully: ${email}`);
    return { id: newUser.id, email: newUser.email, username: newUser.username };
  }

  // Login using email/username and password.
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

  // Verify the email using the token from the URL.
  async verifyEmail(token) {
    if (!token) {
      logger.warn('Email verification attempt without token');
      throw new AppError(400, 'Verification token is required');
    }

    // Hash the incoming token to compare with the stored hashed token.
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await prisma.user.findFirst({
      where: {
        verificationToken: hashedToken,
        verificationTokenExpires: { gt: new Date() },
      },
    });

    if (!user) {
      logger.warn(`Invalid or expired verification token attempt: ${token}`);
      throw new AppError(400, 'Invalid or expired verification token');
    }

    if (user.isVerified) {
      logger.info(`User already verified: ${user.email}`);
      throw new AppError(400, 'Email already verified');
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        verificationToken: null,
        verificationTokenExpires: null,
        failedLoginAttempts: 0,
        accountLockedUntil: null,
      },
    });

    logger.info(`Email verified successfully for user: ${user.email}`);
    const tokens = await this.generateTokens(updatedUser.id, updatedUser.role);
    return {
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        username: updatedUser.username,
        role: updatedUser.role,
      },
      tokens,
    };
  }

  // Logout by blacklisting the refresh token.
  async logout(refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      logger.info(`Logged out token with jti: ${decoded.jti}`);
    } catch (error) {
      logger.error('Logout failed:', error);
      throw new AppError(401, 'Invalid refresh token');
    }
  }

  // Refresh the access token.
  async refreshToken(refreshToken) {
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (error) {
      logger.error('Refresh token verification failed:', error);
      throw new AppError(401, 'Invalid refresh token');
    }
    logger.info(`Refreshing tokens for user: ${decoded.userId}`);
    return this.generateTokens(decoded.userId, decoded.role);
  }

  // Initiate the forgot password process.
  async forgotPassword(email, req) {
    logger.info(`Password reset requested for email: ${email}`);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      logger.warn(`Password reset requested for non-existing email: ${email}`);
      return;
    }

    // Generate raw and hashed tokens.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: hashedToken,
        resetPasswordExpire: expires,
      },
    });

    await notificationService.sendPasswordResetNotification(email, rawToken, req);
    logger.info(`Password reset token sent to email: ${email}`);
  }

  // Complete the password reset process.
  async resetPassword(rawToken, newPassword) {
    logger.info('Resetting password using token');
    if (!rawToken) {
      throw new AppError(400, 'Invalid reset token');
    }

    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: hashedToken,
        resetPasswordExpire: { gt: new Date() },
      },
    });

    if (!user) {
      logger.warn('Invalid or expired reset token');
      throw new AppError(400, 'Invalid or expired token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          resetPasswordToken: null,
          resetPasswordExpire: null,
        },
      }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    logger.info(`Password reset successful for user: ${user.email}`);
  }

  // Update the user's password.
  async updatePassword(userId, currentPassword, newPassword) {
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
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      }),
      prisma.refreshToken.deleteMany({ where: { userId } }),
    ]);

    logger.info(`Password updated successfully for user: ${userId}`);
  }

  async handleGoogleLogin(profile) {
    const { id: googleId, displayName, emails, name } = profile;
    const email = emails[0].value;
    const firstName = name?.givenName || '';
    const lastName = name?.familyName || '';
  
    let user = await prisma.user.findUnique({ where: { email } });
  
    if (user) {
      if (!user.isGoogleUser) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId,
            isGoogleUser: true,
            isVerified: true,
          },
        });
      }
    } else {
      const username = email.split('@')[0];
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hashedPassword = await hashPassword(randomPassword);
  
      user = await prisma.user.create({
        data: {
          email,
          username,
          firstName,
          lastName,
          password: hashedPassword,
          googleId,
          isGoogleUser: true,
          isVerified: true,
          role: UserRole.USER,
        },
      });
    }
  
    return user;
  }  


  
  
  // Generate a new access and refresh token pair.
  async generateTokens(userId, role) {
    // Generate a unique token identifier
    const jti = crypto.randomUUID();

    // Include the jti in both tokens
    const accessTokenPayload = { userId, role, jti };
    const refreshTokenPayload = { userId, role, jti };

    const accessTokenOptions = { expiresIn: parseExpiration(JWT_EXPIRES_IN) };
    const refreshTokenOptions = { expiresIn: parseExpiration(REFRESH_TOKEN_EXPIRY) };

    const accessToken = jwt.sign(
      accessTokenPayload,
      process.env.JWT_ACCESS_SECRET,
      accessTokenOptions
    );
    const refreshToken = jwt.sign(
      refreshTokenPayload,
      process.env.JWT_REFRESH_SECRET,
      refreshTokenOptions
    );

    // Save the refresh token in the database.
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId,
        expiresAt: new Date(Date.now() + parseExpiration(REFRESH_TOKEN_EXPIRY)),
      },
    });

    logger.info(`Tokens generated for user: ${userId}`);
    return { accessToken, refreshToken };
  }

  // Compare a candidate password with the hashed password.
  async verifyPassword(hashedPassword, candidatePassword) {
    const isMatch = await bcrypt.compare(candidatePassword, hashedPassword);
    if (!isMatch) {
      logger.warn('Password verification failed');
      throw new AppError(401, 'Invalid credentials');
    }
  }

  // Validate that the login attempt meets basic requirements.
  validateLoginAttempt(user, ip) {
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
    const attempts = currentAttempts + 1;
    const lockDuration = this.calculateLockDuration(attempts);

    await prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: attempts,
        accountLockedUntil: lockDuration,
      },
    });

    logger.warn(`Failed login attempts for user ${userId}: ${attempts}`);
  }

  calculateLockDuration(attempts) {
    if (attempts >= 5) {
      return new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    }
    if (attempts >= 3) {
      return new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    }
    return null;
  }

  // Reset the failed login attempt counters.
  async resetFailedAttempts(userId) {
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
