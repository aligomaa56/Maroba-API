import nodemailer from 'nodemailer';
import logger from '../middleware/logger.middleware.js';
import { env } from '../config/env.config.js';
import path from 'path';
import fs from 'fs/promises';
import handlebars from 'handlebars';
import { AppError } from '../middleware/error.middleware.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class NotificationService {
  constructor() {
    this.templateDir = path.join(__dirname, '../../email');
    this.templateCache = new Map();
    this.failedAttempts = new Map();
    
    // Initialize transporter immediately
    this.initializeTransporter();
    
    // Verify connection immediately
    this.verifyConnection()
      .then(() => {
        logger.info('Email service initialized successfully');
        // Preload templates only after successful connection
        return this.preloadTemplates(['welcome', 'verify-email', 'reset-password']);
      })
      .catch((error) => {
        logger.error('Email service initialization failed:', error);
      });

    // Cleanup failed attempts every hour
    setInterval(() => this.cleanupFailedAttempts(), 3600000);
  }

  initializeTransporter() {
    try {
      if (env.NODE_ENV === 'production') {
        this.validateProductionConfig();
        this.transporter = nodemailer.createTransport({
          service: 'gmail',
          pool: true,
          maxConnections: 5,
          maxMessages: 100,
          rateDelta: 1000,
          rateLimit: 5,
          auth: {
            user: env.EMAIL_USER,
            pass: env.EMAIL_PASSWORD,
          },
          tls: { rejectUnauthorized: false },
        });
        this.senderEmail = env.EMAIL_USER;
      } else {
        this.validateDevelopmentConfig();
        this.transporter = nodemailer.createTransport({
          host: env.MAILOSAUR_SMTP_HOST,
          port: env.MAILOSAUR_SMTP_PORT,
          secure: false,
          auth: {
            user: env.MAILOSAUR_USER,
            pass: env.MAILOSAUR_PASSWORD,
          },
        });
        this.senderEmail = env.MAILOSAUR_SENDER_EMAIL;
      }
      logger.info(`Initialized ${env.NODE_ENV} email transporter`);
    } catch (error) {
      logger.error('Failed to initialize email transporter:', error);
      throw new AppError(500, 'Email service initialization failed');
    }
  }

  validateProductionConfig() {
    if (!env.EMAIL_USER || !env.EMAIL_PASSWORD) {
      throw new AppError(
        500,
        [
          'Missing production email configuration',
          'Required environment variables:',
          '- EMAIL_USER',
          '- EMAIL_PASSWORD',
        ].join('\n')
      );
    }
  }

  validateDevelopmentConfig() {
    const required = [
      'MAILOSAUR_SMTP_HOST',
      'MAILOSAUR_SMTP_PORT',
      'MAILOSAUR_SENDER_EMAIL',
      'MAILOSAUR_USER',
      'MAILOSAUR_PASSWORD',
    ].filter((varName) => !env[varName]);

    if (required.length > 0) {
      throw new AppError(
        500,
        [
          'Missing development email configuration:',
          ...required.map((v) => `- ${v}`),
        ].join('\n')
      );
    }
  }

  async verifyConnection() {
    try {
      await this.transporter.verify();
      logger.info('SMTP connection verified successfully');
    } catch (error) {
      logger.error('SMTP connection verification failed:', error);
      // Don't throw here, just log the error
    }
  }

  async preloadTemplates(templateNames) {
    try {
      const promises = templateNames.map(name => this.loadTemplate(name));
      await Promise.all(promises);
      logger.info(`Preloaded ${templateNames.length} email templates`);
    } catch (error) {
      logger.warn('Failed to preload some email templates:', error);
    }
  }

  async loadTemplate(templateName) {
    // Check cache first
    const cached = this.templateCache.get(templateName);
    if (cached) {
      return cached.template;
    }

    try {
      const templatePath = path.join(this.templateDir, `${templateName}.hbs`);
      const source = await fs.readFile(templatePath, 'utf-8');
      const compiledTemplate = handlebars.compile(source);
      
      // Cache with timestamp for potential future cache invalidation
      this.templateCache.set(templateName, {
        template: compiledTemplate,
        timestamp: Date.now()
      });
      
      return compiledTemplate;
    } catch (error) {
      logger.error(`Template loading failed for "${templateName}":`, error);
      throw new AppError(500, `Failed to load template: ${templateName}`);
    }
  }

  async sendEmail(options) {
    const MAX_RETRIES = 3;
    const recipient = options.to;

    // Check failed attempts
    const failedAttempts = this.failedAttempts.get(recipient) || { count: 0, timestamp: Date.now() };
    if (failedAttempts.count >= 5) {
      const timeSinceLastAttempt = Date.now() - failedAttempts.timestamp;
      if (timeSinceLastAttempt < 3600000) { // 1 hour
        logger.warn(`Too many failed attempts for recipient: ${recipient}`);
        throw new AppError(429, 'Too many failed attempts. Please try again later.');
      }
      this.failedAttempts.delete(recipient);
    }

    // Don't use background processing in serverless environment
    let attempt = 0;
    while (attempt < MAX_RETRIES) {
      try {
        const template = await this.loadTemplate(options.template);
        const info = await this.transporter.sendMail({
          from: `"${env.APP_NAME}" <${this.senderEmail}>`,
          to: options.to,
          subject: options.subject,
          html: template(options.context),
          ...(options.cc && { cc: options.cc }),
          ...(options.bcc && { bcc: options.bcc }),
          ...(options.attachments && { attachments: options.attachments })
        });

        this.failedAttempts.delete(recipient);
        logger.info(`Email sent successfully to ${options.to} (${info.messageId})`);
        
        return {
          success: true,
          messageId: info.messageId,
          response: info.response
        };
      } catch (error) {
        attempt++;
        failedAttempts.count++;
        failedAttempts.timestamp = Date.now();
        this.failedAttempts.set(recipient, failedAttempts);

        logger.error(`Email attempt ${attempt} failed:`, {
          error: error.message,
          recipient: options.to,
          attempt: attempt
        });

        if (attempt === MAX_RETRIES) {
          throw new AppError(500, 'Failed to send email after multiple attempts');
        }

        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  cleanupFailedAttempts() {
    const oneHourAgo = Date.now() - 3600000;
    for (const [recipient, data] of this.failedAttempts.entries()) {
      if (data.timestamp < oneHourAgo) {
        this.failedAttempts.delete(recipient);
      }
    }
  }

  // Notification methods
  async sendWelcomeNotification(email, username, req) {
    return this.sendEmail({
      to: email,
      subject: 'Welcome to Our Service',
      template: 'welcome',
      context: {
        appName: env.APP_NAME || 'Our Service',
        username,
        loginLink: `${req.protocol}://${req.get('host')}/api/auth/login`,
        currentYear: new Date().getFullYear(), // For copyright in footer
      },
    });
  }

  async sendVerificationNotification(email, token, req) {
    try {
      const verificationLink = env.CLIENT_URL + `/verify-email?token=${token}`;
      
      logger.info(`Sending verification email to: ${email}`);
      logger.debug(`Verification link: ${verificationLink}`);

      const result = await this.sendEmail({
        to: email,
        subject: 'Verify Your Email Address',
        template: 'verify-email',
        context: {
          appName: env.APP_NAME || 'Our Service',
          verificationLink,
          expiryHours: 24,
          currentYear: new Date().getFullYear(),
        },
      });

      logger.info(`Verification email sent successfully to: ${email}`);
      return result;
    } catch (error) {
      logger.error(`Failed to send verification email to ${email}:`, error);
      throw new AppError(500, 'Failed to send verification email. Please try again.');
    }
  }

  async sendPasswordResetNotification(email, token, req) {
    try {
      const resetLink = env.CLIENT_URL + `/reset-password?token=${token}`;
      
      logger.info(`Sending password reset email to: ${email}`);
      logger.debug(`Reset link: ${resetLink}`);

      const result = await this.sendEmail({
        to: email,
        subject: 'Reset Your Password',
        template: 'reset-password',
        context: {
          appName: env.APP_NAME || 'Our Service',
          resetLink,
          expiryHours: 1, // Matches PASSWORD_RESET_EXPIRES_IN from auth.service
          currentYear: new Date().getFullYear(),
        },
      });

      logger.info(`Password reset email sent successfully to: ${email}`);
      return result;
    } catch (error) {
      logger.error(`Failed to send password reset email to ${email}:`, error);
      throw new AppError(500, 'Failed to send password reset email. Please try again.');
    }
  }

  async sendOrderConfirmationNotification(email, orderDetails) {
    return this.sendEmail({
      to: email,
      subject: `Order Confirmation #${orderDetails.orderNumber || ''}`,
      template: 'order-confirmation',
      context: {
        appName: env.APP_NAME || 'Our Service',
        ...orderDetails,
        currentYear: new Date().getFullYear(),
      },
    });
  }

  // New method for generic notifications
  async sendGenericNotification(email, subject, template, context) {
    return this.sendEmail({
      to: email,
      subject,
      template,
      context: {
        appName: env.APP_NAME || 'Our Service',
        currentYear: new Date().getFullYear(),
        ...context,
      },
    });
  }
}

export const notificationService = new NotificationService();