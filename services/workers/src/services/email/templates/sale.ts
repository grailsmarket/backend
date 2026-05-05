import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, highlight, escapeHtml } from '../components';

export function buildSaleEmail(params: {
  ensName: string;
  priceEth: string;
  listingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, priceEth, listingUrl, unsubscribeUrl } = params;
  const subject = `Sold: ${ensName}`;
  const preheaderText = `${ensName} just sold for ${priceEth} ETH.`;

  const body = `
    ${bodyIntro(
      `${escapeHtml(ensName)} sold`,
      `<strong>${escapeHtml(ensName)}</strong>, a name on your watchlist, just changed hands.`,
    )}
    ${highlight('Sale price', `${escapeHtml(priceEth)} ETH`)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 8px 0 8px 0;">
      ${button(listingUrl, 'View on Grails')}
    </td></tr></table>
    ${footerNote(`You received this email because you're watching ${escapeHtml(ensName)} on Grails.`, unsubscribeUrl)}
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `Sold: ${ensName}\n\n${ensName}, a name on your watchlist, just changed hands.\n\nSale price: ${priceEth} ETH\n\nView: ${listingUrl}\n\n---\nYou received this email because you're watching ${ensName} on Grails.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
