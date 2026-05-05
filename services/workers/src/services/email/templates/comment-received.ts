import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, escapeHtml } from '../components';

/**
 * Generic per product spec — no comment text leaked into email since it's
 * untrusted user input.
 */
export function buildCommentReceivedEmail(params: {
  ensName: string;
  nameUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, nameUrl, unsubscribeUrl } = params;
  const subject = `New comment on ${ensName}`;
  const preheaderText = `Someone just commented on ${ensName}.`;

  const body = `
    ${bodyIntro(
      `New comment on ${escapeHtml(ensName)}`,
      `Someone just posted a comment on <strong>${escapeHtml(ensName)}</strong>.`,
    )}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 16px 0 8px 0;">
      ${button(nameUrl, 'View on Grails')}
    </td></tr></table>
    ${footerNote(`You received this email because of your notification preferences on Grails.`, unsubscribeUrl)}
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `New comment on ${ensName}\n\nSomeone just posted a comment on ${ensName}.\n\nView: ${nameUrl}\n\n---\nYou received this email because of your notification preferences on Grails.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
