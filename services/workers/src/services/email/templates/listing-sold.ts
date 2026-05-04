import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, highlight, escapeHtml } from '../components';

export function buildListingSoldEmail(params: {
  ensName: string;
  priceEth: string;
  saleUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { ensName, priceEth, saleUrl, unsubscribeUrl } = params;
  const subject = `Your listing for ${ensName} sold`;
  const preheaderText = `${ensName} sold for ${priceEth} ETH.`;

  const body = `
    ${bodyIntro(
      `Your listing sold`,
      `Your listing for <strong>${escapeHtml(ensName)}</strong> just sold on Grails.`,
    )}
    ${highlight('Sale price', `${escapeHtml(priceEth)} ETH`)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 8px 0 8px 0;">
      ${button(saleUrl, 'View sale details')}
    </td></tr></table>
    ${footerNote(`You received this email because your listing was sold on Grails.`, unsubscribeUrl)}
  `;

  return {
    subject,
    html: renderEmailLayout({ subject, preheaderText, body }),
    text: `Your listing for ${ensName} sold\n\nYour listing for ${ensName} just sold on Grails.\n\nSale price: ${priceEth} ETH\n\nView details: ${saleUrl}\n\n---\nYou received this email because your listing was sold on Grails.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
