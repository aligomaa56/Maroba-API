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

// Cache for compiled templates
const templateCache = new Map();

class NotificationService {
  constructor() {
    this.templateDir = path.join(__dirname, '../../email');
    this.initializeTransporter();
    
    // Verify connection but don't exit process on failure - just log the error
    this.verifyConnection().catch((error) => {
      logger.error('SMTP initialization failed:', error);
    });
    
    // Pre-load common templates
    this.preloadTemplates(['welcome', 'verify-email', 'reset-password',]);
  }

  initializeTransporter() {
    try {
      if (env.NODE_ENV === 'production') {
        this.validateProductionConfig();
        this.transporter = nodemailer.createTransport({
          service: 'gmail',
          pool: true,
          maxConnections: 5, // Limit parallel connections
          rateDelta: 1000,    // Minimum time between messages
          rateLimit: 5,       // Max messages per rateDelta
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
    // Return cached template if available
    if (templateCache.has(templateName)) {
      return templateCache.get(templateName);
    }

    try {
      const templatePath = path.join(this.templateDir, `${templateName}.hbs`);
      const source = await fs.readFile(templatePath, 'utf-8');
      const compiledTemplate = handlebars.compile(source);
      
      // Cache the compiled template
      templateCache.set(templateName, compiledTemplate);
      return compiledTemplate;
    } catch (error) {
      logger.error(`Template loading failed for "${templateName}":`, error);
      throw new AppError(500, `Failed to load template: ${templateName}`);
    }
  }

  async sendEmail(options) {
    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
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
            to: options.to,
          },
          // Add optional CC and BCC if provided
          ...(options.cc && { cc: options.cc }),
          ...(options.bcc && { bcc: options.bcc }),
          // Add attachments if provided
          ...(options.attachments && { attachments: options.attachments }),
        };

        const info = await this.transporter.sendMail(mailOptions);
        logger.info(`Email sent to ${options.to} (${info.messageId})`);

        return {
          success: true,
          messageId: info.messageId,
          response: info.response,
        };
      } catch (error) {
        attempt++;
        logger.warn(`Email attempt ${attempt} failed: ${error.message}`);

        if (attempt === MAX_RETRIES) {
          logger.error('Email delivery failed after retries:', {
            error: error.message,
            recipient: options.to,
            stack: error.stack,
          });

          throw new AppError(500, 'Failed to send email', {
            recipient: options.to,
            error: error.message,
          });
        }

        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
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
    const verificationLink = `${req.protocol}://${req.get(
      'host'
    )}/api/auth/verify-email?token=${token}`;

    return this.sendEmail({
      to: email,
      subject: 'Verify Your Email Address',
      template: 'verify-email',
      context: {
        appName: env.APP_NAME || 'Our Service',
        verificationLink,
        expiryHours: 24, // This should match your actual token expiry
        currentYear: new Date().getFullYear(),
      },
    });
  }

  async sendPasswordResetNotification(email, token, req) {
    const resetLink = `${req.protocol}://${req.get(
      'host'
    )}/api/auth/reset-password?token=${token}`;

    return this.sendEmail({
      to: email,
      subject: 'Password Reset Request',
      template: 'reset-password',
      context: {
        appName: env.APP_NAME || 'Our Service',
        resetLink,
        expiryHours: 1, // This should match your actual token expiry
        currentYear: new Date().getFullYear(),
      },
    });
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
  
  // Method to clear template cache (useful for testing or template updates)
  clearTemplateCache() {
    templateCache.clear();
    logger.info('Email template cache cleared');
  }
}

export const notificationService = new NotificationService();