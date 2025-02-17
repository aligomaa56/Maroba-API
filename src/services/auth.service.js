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

  async logout(refreshToken) {
    if (!refreshToken) {
      throw new AppError(400, 'Refresh token is required');
    }

    try {
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

      // Delete all refresh tokens for the user
      await prisma.refreshToken.deleteMany({
        where: { userId: decoded.userId },
      });

      logger.info(`Logged out all sessions for user: ${decoded.userId}`);
    } catch (error) {
      logger.error('Logout failed:', error);
    }
  }

  async refreshToken(refreshToken) {
    if (!refreshToken) {
      throw new AppError(400, 'Refresh token is required');
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (error) {
      logger.error('Refresh token verification failed:', error);
      throw new AppError(401, 'Invalid refresh token');
    }

    // Check if the token exists in the database
    const storedToken = await prisma.refreshToken.findFirst({
      where: {
        token: refreshToken,
        userId: decoded.userId,
      },
    });

    if (!storedToken) {
      logger.warn(
        `Refresh token not found in database for user: ${decoded.userId}`
      );
      throw new AppError(401, 'Invalid refresh token');
    }

    // Check if the token has expired in the database
    if (storedToken.expiresAt < new Date()) {
      logger.warn(`Expired refresh token used for user: ${decoded.userId}`);
      throw new AppError(401, 'Refresh token has expired');
    }

    logger.info(`Refreshing tokens for user: ${decoded.userId}`);
    return this.generateTokens(decoded.userId, decoded.role);
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

  async resetPassword(rawToken, newPassword) {
    logger.info('Resetting password using token');
    if (!rawToken) {
      throw new AppError(400, 'Invalid reset token');
    }

    const hashedToken = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
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

    // Check that the new password is different from the current one.
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      throw new AppError(
        400,
        'New password must be different from the current password'
      );
    }

    const hashedPassword = await hashPassword(newPassword);

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

  async updatePassword(userId, currentPassword, newPassword) {
    if (!userId || !currentPassword || !newPassword) {
      throw new AppError(400, 'All fields are required');
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

    // Check that the new password is different from the current one.
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      throw new AppError(
        400,
        'New password must be different from the current password'
      );
    }

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
    await prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
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
    // Generate a unique token identifier
    const jti = crypto.randomUUID();

    // Include the jti in both tokens
    const accessTokenPayload = { userId, role, jti };
    const refreshTokenPayload = { userId, role, jti };

    const accessTokenOptions = { expiresIn: parsedJwtExpiration };
    const refreshTokenOptions = { expiresIn: parsedRefreshExpiration };

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

    // Calculate expiration date once for refresh token
    const expiresAt = new Date(Date.now() + parsedRefreshExpiration);

    // Save the refresh token in the database.
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId,
        expiresAt,
      },
    });

    logger.info(`Tokens generated for user: ${userId}`);
    return { accessToken, refreshToken };
  }

  async verifyPassword(hashedPassword, candidatePassword) {
    if (!hashedPassword || !candidatePassword) {
      throw new AppError(400, 'Password verification failed: Missing data');
    }

    const isMatch = await bcrypt.compare(candidatePassword, hashedPassword);
    if (!isMatch) {
      logger.warn('Password verification failed');
      throw new AppError(401, 'Invalid credentials');
    }
  }

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
    if (!userId) return;

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
