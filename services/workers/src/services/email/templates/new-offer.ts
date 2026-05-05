import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, highlight, escapeHtml } from '../components';

export function buildNewOfferEmail(params: {
  ensName: string;
  priceEth: string;
  offerUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, priceEth, offerUrl, unsubscribeUrl } = params;
  const subject = `New offer: ${ensName}`;
  const preheaderText = `Someone just offered ${priceEth} ETH on ${ensName}.`;

  const body = `
    ${bodyIntro(
      `New offer on ${escapeHtml(ensName)}`,
      `A new offer was just placed on <strong>${escapeHtml(ensName)}</strong>, a name on your watchlist.`,
    )}
    ${highlight('Offer amount', `${escapeHtml(priceEth)} ETH`)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 8px 0 8px 0;">
      ${button(offerUrl, 'View offer')}
    </td></tr></table>
    ${footerNote(`You received this email because you're watching ${escapeHtml(ensName)} on Grails.`, unsubscribeUrl)}
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `New offer: ${ensName}\n\nA new offer was just placed on ${ensName}, a name on your watchlist.\n\nOffer amount: ${priceEth} ETH\n\nView offer: ${offerUrl}\n\n---\nYou received this email because you're watching ${ensName} on Grails.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
