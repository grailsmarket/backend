import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, escapeHtml } from '../components';

export function buildListingCancelledEmail(params: {
  ensName: string;
  listingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, listingUrl, unsubscribeUrl } = params;
  const subject = `Listing cancelled: ${ensName}`;
  const preheaderText = `The listing for ${ensName} was cancelled after an ownership change.`;

  const body = `
    ${bodyIntro(
      `Listing cancelled`,
      `The listing for <strong>${escapeHtml(ensName)}</strong> was cancelled because the name was transferred to a new owner, which invalidates the existing listing.`,
    )}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 16px 0 8px 0;">
      ${button(listingUrl, 'View on Grails')}
    </td></tr></table>
    ${footerNote(`You received this email because you're watching ${escapeHtml(ensName)} on Grails.`, unsubscribeUrl)}
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `Listing cancelled: ${ensName}\n\nThe listing for ${ensName} was cancelled because the name was transferred to a new owner.\n\nView: ${listingUrl}\n\n---\nYou received this email because you're watching ${ensName} on Grails.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
