import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro } from '../layout';
import { button } from '../components';
import { colors, fonts } from '../tokens';

export function buildEmailVerificationEmail(params: {
  verificationUrl: string;
}): EmailTemplate {
  const { verificationUrl } = params;
  const subject = `Verify your email — Grails`;
  const preheaderText = `Confirm your email to start receiving Grails notifications.`;

  const body = `
    ${bodyIntro(
      `Verify your email`,
      `Thanks for adding your email to Grails. Click the button below to confirm it and start receiving notifications about the names you watch and own.`,
    )}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 24px 0 8px 0;">
      ${button(verificationUrl, 'Verify email')}
    </td></tr></table>
    <p style="margin: 24px 0 0 0; font-family: ${fonts.body}; font-size: 13px; color: ${colors.textMuted}; line-height: 1.6; word-break: break-all;">
      Or paste this link into your browser:<br>
      <a href="${encodeURI(verificationUrl)}" style="color: ${colors.accent};">${encodeURI(verificationUrl)}</a>
    </p>
    <p style="margin: 24px 0 0 0; font-family: ${fonts.body}; font-size: 13px; color: ${colors.textMuted}; line-height: 1.6;">
      This link expires in 24 hours. If you didn't add this email to Grails, you can safely ignore this message.
    </p>
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `Verify your email — Grails\n\nThanks for adding your email to Grails. Confirm it by visiting:\n\n${verificationUrl}\n\nThis link expires in 24 hours. If you didn't add this email to Grails, you can safely ignore this message.`,
  };
}
