import nodemailer from 'nodemailer';
import logger from '../middleware/logger.middleware.js';
import { env } from '../config/env.config.js';
import path from 'path';
import fs from 'fs/promises';
import handlebars from 'handlebars';
import { AppError } from '../middleware/error.middleware.js';
import { fileURLToPath } from 'url';

// Define __filename and __dirname for ES modules.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class NotificationService {
  constructor() {
    // Set the directory for email templates.
    this.templateDir = path.join(__dirname, '../../email');

    // Configure the transporter based on the environment.
    if (env.NODE_ENV === 'production') {
      // Validate production environment variables.
      if (!env.EMAIL_USER || !env.EMAIL_PASSWORD) {
        throw new AppError(500, 'Missing email configuration for production environment');
      }

      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: env.EMAIL_USER,
          pass: env.EMAIL_PASSWORD,
        },
        tls: {
          rejectUnauthorized: false,
        },
      });
      this.senderEmail = env.EMAIL_USER;
    } else {
      // Validate development environment variables.
      if (
        !env.MAILOSAUR_SMTP_HOST ||
        !env.MAILOSAUR_SENDER_EMAIL ||
        !env.MAILOSAUR_USER ||
        !env.MAILOSAUR_PASSWORD
      ) {
        throw new AppError(500, 'Missing Mailosaur configuration for development environment');
      }

      this.transporter = nodemailer.createTransport({
        host: env.MAILOSAUR_SMTP_HOST,
        port: env.MAILOSAUR_SMTP_PORT,
        secure: env.MAILOSAUR_SMTP_SECURE,
        auth: {
          user: env.MAILOSAUR_USER,
          pass: env.MAILOSAUR_PASSWORD,
        },
      });
      this.senderEmail = env.MAILOSAUR_SENDER_EMAIL;
    }

    logger.info(`Initialized ${env.NODE_ENV} email transporter with sender: ${this.senderEmail}`);
    this.verifyConnection();
  }

  async verifyConnection() {
    try {
      await this.transporter.verify();
      logger.info('SMTP connection verified successfully');
    } catch (error) {
      logger.error('Error verifying SMTP connection:', error);
      throw new AppError(500, 'Failed to verify SMTP connection');
    }
  }

  async loadTemplate(templateName) {
    try {
      const templatePath = path.join(this.templateDir, `${templateName}.hbs`);
      const source = await fs.readFile(templatePath, 'utf-8');
      return handlebars.compile(source);
    } catch (error) {
      logger.error('Error loading email template:', error);
      throw new AppError(500, 'Failed to load email template');
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
      };

      await this.transporter.sendMail(mailOptions);
      logger.info(`Email sent to ${options.to} via ${env.NODE_ENV} service`);
      return true;
    } catch (error) {
      logger.error('Email sending failed:', error);
      throw new AppError(500, 'Failed to send email');
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
        verificationLink: verificationLink,
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
        resetLink: resetLink,
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
