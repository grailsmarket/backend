import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';
import { config } from '../../../shared/src';

const FROM_EMAIL = config.email.fromEmail;
const ENABLE_EMAIL = config.email.enabled;
const SMTP_CONFIG = {
  server: config.email.smtpServer,
  port: config.email.smtpPort,
  login: config.email.smtpLogin,
  password: config.email.smtpPassword,
};

// Check if SMTP is configured
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

/**
 * Send email via nodemailer (SMTP)
 */
export async function sendEmail(to: string, template: EmailTemplate): Promise<void> {
  // If email disabled or no SMTP config, just log
  if (!isSmtpConfigured || !ENABLE_EMAIL) {
    logger.info({ to, subject: template.subject }, 'Email send (dry-run mode - email disabled)');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_CONFIG.server,
    port: SMTP_CONFIG.port,
    secure: SMTP_CONFIG.port === 465, // true for 465, false for other ports
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

/**
 * Build email template for new listing notification
 */
export function buildNewListingEmail(params: {
  ensName: string;
  priceEth: string;
  listingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, priceEth, listingUrl, unsubscribeUrl } = params;

  return {
    subject: `New Listing: ${ensName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>New Listing on Grails</h2>
        <p>A new listing has been created for <strong>${ensName}</strong> that you're watching.</p>
        <p><strong>Price:</strong> ${priceEth} ETH</p>
        <p><a href="${listingUrl}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 10px 0;">View Listing</a></p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666;">
          You received this email because you're watching ${ensName} on Grails.
          <a href="${unsubscribeUrl}">Manage notification preferences</a>
        </p>
      </div>
    `,
    text: `
New Listing: ${ensName}

A new listing has been created for ${ensName} that you're watching.

Price: ${priceEth} ETH

View listing: ${listingUrl}

---
You received this email because you're watching ${ensName} on Grails.
Manage notification preferences: ${unsubscribeUrl}
    `.trim(),
  };
}

/**
 * Build email template for price change notification
 */
export function buildPriceChangeEmail(params: {
  ensName: string;
  oldPriceEth: string;
  newPriceEth: string;
  listingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, oldPriceEth, newPriceEth, listingUrl, unsubscribeUrl } = params;
  const priceDirection = parseFloat(newPriceEth) < parseFloat(oldPriceEth) ? 'decreased' : 'increased';

  return {
    subject: `Price Change: ${ensName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Price Change on Grails</h2>
        <p>The price for <strong>${ensName}</strong> has ${priceDirection}.</p>
        <p><strong>Old Price:</strong> ${oldPriceEth} ETH</p>
        <p><strong>New Price:</strong> ${newPriceEth} ETH</p>
        <p><a href="${listingUrl}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 10px 0;">View Listing</a></p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666;">
          You received this email because you're watching ${ensName} on Grails.
          <a href="${unsubscribeUrl}">Manage notification preferences</a>
        </p>
      </div>
    `,
    text: `
Price Change: ${ensName}

The price for ${ensName} has ${priceDirection}.

Old Price: ${oldPriceEth} ETH
New Price: ${newPriceEth} ETH

View listing: ${listingUrl}

---
You received this email because you're watching ${ensName} on Grails.
Manage notification preferences: ${unsubscribeUrl}
    `.trim(),
  };
}

/**
 * Build email template for sale notification
 */
export function buildSaleEmail(params: {
  ensName: string;
  priceEth: string;
  listingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, priceEth, listingUrl, unsubscribeUrl } = params;

  return {
    subject: `Sold: ${ensName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>ENS Name Sold on Grails</h2>
        <p><strong>${ensName}</strong> has been sold!</p>
        <p><strong>Sale Price:</strong> ${priceEth} ETH</p>
        <p><a href="${listingUrl}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 10px 0;">View Details</a></p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666;">
          You received this email because you're watching ${ensName} on Grails.
          <a href="${unsubscribeUrl}">Manage notification preferences</a>
        </p>
      </div>
    `,
    text: `
Sold: ${ensName}

${ensName} has been sold!

Sale Price: ${priceEth} ETH

View details: ${listingUrl}

---
You received this email because you're watching ${ensName} on Grails.
Manage notification preferences: ${unsubscribeUrl}
    `.trim(),
  };
}

/**
 * Build email template for new offer notification
 */
export function buildNewOfferEmail(params: {
  ensName: string;
  priceEth: string;
  offerUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, priceEth, offerUrl, unsubscribeUrl } = params;

  return {
    subject: `New Offer: ${ensName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>New Offer on Grails</h2>
        <p>A new offer has been made on <strong>${ensName}</strong> that you're watching.</p>
        <p><strong>Offer Amount:</strong> ${priceEth} ETH</p>
        <p><a href="${offerUrl}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 10px 0;">View Offer</a></p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666;">
          You received this email because you're watching ${ensName} on Grails.
          <a href="${unsubscribeUrl}">Manage notification preferences</a>
        </p>
      </div>
    `,
    text: `
New Offer: ${ensName}

A new offer has been made on ${ensName} that you're watching.

Offer Amount: ${priceEth} ETH

View offer: ${offerUrl}

---
You received this email because you're watching ${ensName} on Grails.
Manage notification preferences: ${unsubscribeUrl}
    `.trim(),
  };
}

/**
 * Build email template for listing cancelled (ownership change) notification
 */
export function buildListingCancelledEmail(params: {
  ensName: string;
  listingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, listingUrl, unsubscribeUrl } = params;

  return {
    subject: `Listing Cancelled: ${ensName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Listing Cancelled on Grails</h2>
        <p>The listing for <strong>${ensName}</strong> has been cancelled due to an ownership change.</p>
        <p>The ENS name was transferred to a new owner, making the listing invalid.</p>
        <p><a href="${listingUrl}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 10px 0;">View Details</a></p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666;">
          You received this email because you're watching ${ensName} on Grails.
          <a href="${unsubscribeUrl}">Manage notification preferences</a>
        </p>
      </div>
    `,
    text: `
Listing Cancelled: ${ensName}

The listing for ${ensName} has been cancelled due to an ownership change.

The ENS name was transferred to a new owner, making the listing invalid.

View details: ${listingUrl}

---
You received this email because you're watching ${ensName} on Grails.
Manage notification preferences: ${unsubscribeUrl}
    `.trim(),
  };
}

/**
 * Build email template for email verification
 */
export function buildEmailVerificationEmail(params: {
  verificationUrl: string;
}): EmailTemplate {
  const { verificationUrl } = params;

  return {
    subject: 'Verify your email address - Grails',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Verify Your Email Address</h2>
        <p>Thank you for adding your email address to Grails!</p>
        <p>To receive notifications about your watched ENS names, please verify your email address by clicking the button below:</p>
        <p>
          <a href="${verificationUrl}"
             style="background-color: #7C3AED; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0; font-weight: bold;">
            Verify Email Address
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">
          Or copy and paste this link into your browser:<br>
          <a href="${verificationUrl}" style="color: #7C3AED;">${verificationUrl}</a>
        </p>
        <p style="color: #666; font-size: 14px; margin-top: 30px;">
          This link will expire in 24 hours. If you didn't add this email address to Grails, you can safely ignore this email.
        </p>
      </div>
    `,
    text: `
Verify Your Email Address

Thank you for adding your email address to Grails!

To receive notifications about your watched ENS names, please verify your email address by visiting this link:

${verificationUrl}

This link will expire in 24 hours. If you didn't add this email address to Grails, you can safely ignore this email.
    `.trim(),
  };
}
