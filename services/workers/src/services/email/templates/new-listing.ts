import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, highlight, escapeHtml } from '../components';

export function buildNewListingEmail(params: {
  ensName: string;
  priceEth: string;
  listingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, priceEth, listingUrl, unsubscribeUrl } = params;
  const subject = `New listing: ${ensName}`;
  const preheaderText = `${ensName} just listed for ${priceEth} ETH on Grails.`;

  const body = `
    ${bodyIntro(
      `New listing on Grails`,
      `A new listing was just created for <strong>${escapeHtml(ensName)}</strong>, a name on your watchlist.`,
    )}
    ${highlight('List price', `${escapeHtml(priceEth)} ETH`)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 8px 0 8px 0;">
      ${button(listingUrl, 'View listing')}
    </td></tr></table>
    ${footerNote(`You received this email because you're watching ${escapeHtml(ensName)} on Grails.`, unsubscribeUrl)}
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `New listing: ${ensName}\n\nA new listing was just created for ${ensName}, a name on your watchlist.\n\nList price: ${priceEth} ETH\n\nView listing: ${listingUrl}\n\n---\nYou received this email because you're watching ${ensName} on Grails.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
