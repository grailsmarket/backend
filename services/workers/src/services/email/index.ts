import nodemailer from 'nodemailer';
import { logger } from '../../utils/logger';
import { config } from '../../../../shared/src';

const FROM_EMAIL = config.email.fromEmail;
const ENABLE_EMAIL = config.email.enabled;
const SMTP_CONFIG = {
  server: config.email.smtpServer,
  port: config.email.smtpPort,
  login: config.email.smtpLogin,
  password: config.email.smtpPassword,
};

const isSmtpConfigured = SMTP_CONFIG.server && SMTP_CONFIG.login && SMTP_CONFIG.password;

if (isSmtpConfigured && ENABLE_EMAIL) {
  logger.info({ server: SMTP_CONFIG.server, port: SMTP_CONFIG.port }, 'Email service initialized with nodemailer');
} else {
  logger.warn('Email service disabled (missing SMTP config or ENABLE_EMAIL=false)');
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(to: string, template: EmailTemplate): Promise<void> {
  if (!isSmtpConfigured || !ENABLE_EMAIL) {
    logger.info({ to, subject: template.subject }, 'Email send (dry-run mode - email disabled)');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_CONFIG.server,
    port: SMTP_CONFIG.port,
    secure: SMTP_CONFIG.port === 465,
    auth: {
      user: SMTP_CONFIG.login,
      pass: SMTP_CONFIG.password,
    },
  });

  const mailOptions = {
    from: FROM_EMAIL,
    to,
    subject: template.subject,
    text: template.text,
    html: template.html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info({ to, subject: template.subject, messageId: info.messageId }, 'Email sent successfully');
  } catch (error: any) {
    const errorMessage = error?.message || String(error);

    if (errorMessage.includes('Invalid credentials') || errorMessage.includes('535')) {
      logger.error({ error, to }, 'Email authentication failed - check SMTP credentials');
      throw new Error(`Email authentication failed: ${errorMessage}`);
    }

    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
      logger.error({ error, to }, 'Email server connection failed - check SMTP server and port');
      throw new Error(`Email server connection failed: ${errorMessage}`);
    }

    logger.error({ error, to, subject: template.subject }, 'Failed to send email');
    throw new Error(`Failed to send email: ${errorMessage}`);
  }
}

export { buildNewListingEmail } from './templates/new-listing';
export { buildPriceChangeEmail } from './templates/price-change';
export { buildSaleEmail } from './templates/sale';
export { buildNewOfferEmail } from './templates/new-offer';
export { buildListingCancelledEmail } from './templates/listing-cancelled';
export { buildOfferReceivedEmail } from './templates/offer-received';
export { buildListingSoldEmail } from './templates/listing-sold';
export { buildCommentReceivedEmail } from './templates/comment-received';
export { buildEmailVerificationEmail } from './templates/email-verification';
export { buildAdminBroadcastEmail } from './templates/admin-broadcast';
