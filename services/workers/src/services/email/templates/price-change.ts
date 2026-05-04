import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, highlightCompare, escapeHtml } from '../components';

export function buildPriceChangeEmail(params: {
  ensName: string;
  oldPriceEth: string;
  newPriceEth: string;
  listingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, oldPriceEth, newPriceEth, listingUrl, unsubscribeUrl } = params;
  const direction = parseFloat(newPriceEth) < parseFloat(oldPriceEth) ? 'dropped' : 'increased';
  const subject = `Price ${direction}: ${ensName}`;
  const preheaderText = `${ensName} is now ${newPriceEth} ETH (was ${oldPriceEth} ETH).`;

  const body = `
    ${bodyIntro(
      `Price ${direction} on ${escapeHtml(ensName)}`,
      `The listing for <strong>${escapeHtml(ensName)}</strong> just had a price update.`,
    )}
    ${highlightCompare('Was', `${escapeHtml(oldPriceEth)} ETH`, 'Now', `${escapeHtml(newPriceEth)} ETH`)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 8px 0 8px 0;">
      ${button(listingUrl, 'View listing')}
    </td></tr></table>
    ${footerNote(`You received this email because you're watching ${escapeHtml(ensName)} on Grails.`, unsubscribeUrl)}
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `Price ${direction}: ${ensName}\n\nThe listing for ${ensName} just had a price update.\n\nWas: ${oldPriceEth} ETH\nNow: ${newPriceEth} ETH\n\nView listing: ${listingUrl}\n\n---\nYou received this email because you're watching ${ensName} on Grails.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
