// src/services/notification.service.js
import nodemailer from 'nodemailer';
import logger from '../middleware/logger.middleware.js';
import { env } from '../config/env.config.js';
import path from 'path';
import fs from 'fs/promises';
import handlebars from 'handlebars';
import { AppError } from '../middleware/error.middleware.js';
import { fileURLToPath } from 'url';
import { redisClient } from '../config/redis.config.js';

// Define __filename and __dirname for ES modules.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class NotificationService {
  constructor() {
    // Set the directory for email templates.
    this.templateDir = path.join(__dirname, '../../email');
    this.initializeTransporter();
    this.verifyConnection().catch(error => {
      logger.error('SMTP initialization failed:', error);
      process.exit(1);
    });
  }

  initializeTransporter() {
    if (env.NODE_ENV === 'production') {
      this.validateProductionConfig();
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        pool: true,
        auth: {
          user: env.EMAIL_USER,
          pass: env.EMAIL_PASSWORD
        },
        tls: { rejectUnauthorized: false }
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
          pass: env.MAILOSAUR_PASSWORD
        }
      });
      this.senderEmail = env.MAILOSAUR_SENDER_EMAIL;
    }
    
    logger.info(`Initialized ${env.NODE_ENV} email transporter`);
  }

  validateProductionConfig() {
    if (!env.EMAIL_USER || !env.EMAIL_PASSWORD) {
      throw new AppError(500, [
        'Missing production email configuration',
        'Required environment variables:',
        '- EMAIL_USER',
        '- EMAIL_PASSWORD'
      ].join('\n'));
    }
  }

  validateDevelopmentConfig() {
    const required = [
      'MAILOSAUR_SMTP_HOST',
      'MAILOSAUR_SENDER_EMAIL',
      'MAILOSAUR_USER',
      'MAILOSAUR_PASSWORD'
    ].filter(varName => !env[varName]);

    if (required.length > 0) {
      throw new AppError(500, [
        'Missing development email configuration:',
        ...required.map(v => `- ${v}`)
      ].join('\n'));
    }
  }

  async verifyConnection() {
    try {
      await this.transporter.verify();
      logger.info('SMTP connection verified successfully');
    } catch (error) {
      logger.error('SMTP connection verification failed:', error);
      throw new AppError(500, 'Failed to verify SMTP connection');
    }
  }

  async loadTemplate(templateName) {
    try {
      const templatePath = path.join(this.templateDir, `${templateName}.hbs`);
      const source = await fs.readFile(templatePath, 'utf-8');
      return handlebars.compile(source);
    } catch (error) {
      logger.error('Template loading failed:', error);
      throw new AppError(500, `Failed to load template: ${templateName}`);
    }
  }

  async sendEmail(options) {
    try {
      const template = await this.loadTemplate(options.template);
      const html = template(options.context);

      const mailOptions = {
        from: `"${env.APP_NAME}" <${this.senderEmail}>`,
        to: options.to,
        subject: options.subject,
        html,
        envelope: {
          from: this.senderEmail,
          to: options.to
        }
      };

      const info = await this.transporter.sendMail(mailOptions);
      logger.info(`Email sent to ${options.to} (${info.messageId})`);

      // Log the sent email in Redis (with an expiration of 1 hour).
      await redisClient.set(`notification:sent:${options.to}:${options.template}`, info.messageId, { EX: 3600 });
      
      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error) {
      logger.error('Email delivery failed:', {
        error: error.message,
        recipient: options.to,
        stack: error.stack
      });
      
      throw new AppError(500, 'Failed to send email', {
        recipient: options.to,
        error: error.message
      });
    }
  }

  async sendWelcomeNotification(email, username, req) {
    return this.sendEmail({
      to: email,
      subject: 'Welcome to Our Service',
      template: 'welcome',
      context: {
        appName: env.APP_NAME || 'Our Service',
        username,
        loginLink: `${req.protocol}://${req.get('host')}/api/auth/login`,
      },
    });
  }

  async sendVerificationNotification(email, token, req) {
    const verificationLink = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${token}`;
  
    return this.sendEmail({
      to: email,
      subject: 'Verify Your Email Address',
      template: 'verify-email',
      context: {
        appName: env.APP_NAME || 'Our Service',
        verificationLink,
      },
    });
  }
  
  async sendPasswordResetNotification(email, token, req) {
    const resetLink = `${req.protocol}://${req.get('host')}/api/auth/reset-password?token=${token}`;

    return this.sendEmail({
      to: email,
      subject: 'Password Reset Request',
      template: 'reset-password',
      context: {
        appName: env.APP_NAME || 'Our Service',
        resetLink,
      },
    });
  }

  async sendOrderConfirmationNotification(email, orderDetails) {
    return this.sendEmail({
      to: email,
      subject: 'Order Confirmation',
      template: 'order-confirmation',
      context: {
        appName: env.APP_NAME || 'Our Service',
        ...orderDetails,
      },
    });
  }
}

// Export a singleton instance.
export const notificationService = new NotificationService();
