import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, highlight, escapeHtml } from '../components';

export function buildOfferReceivedEmail(params: {
  ensName: string;
  priceEth: string;
  offerUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, priceEth, offerUrl, unsubscribeUrl } = params;
  const subject = `You received an offer on ${ensName}`;
  const preheaderText = `An offer of ${priceEth} ETH was just placed on ${ensName}.`;

  const body = `
    ${bodyIntro(
      `You received an offer`,
      `Someone just placed an offer on your name <strong>${escapeHtml(ensName)}</strong>.`,
    )}
    ${highlight('Offer amount', `${escapeHtml(priceEth)} ETH`)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 8px 0 8px 0;">
      ${button(offerUrl, 'Review offer')}
    </td></tr></table>
    ${footerNote(`You received this email because you own ${escapeHtml(ensName)}.`, unsubscribeUrl)}
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `You received an offer on ${ensName}\n\nSomeone just placed an offer on your name ${ensName}.\n\nOffer amount: ${priceEth} ETH\n\nReview offer: ${offerUrl}\n\n---\nYou received this email because you own ${ensName}.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
