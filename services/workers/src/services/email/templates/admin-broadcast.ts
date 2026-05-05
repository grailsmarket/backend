import type { EmailTemplate } from '../index';
import { renderEmailLayout, bodyIntro, footerNote } from '../layout';
import { button, escapeHtml } from '../components';

export function buildAdminBroadcastEmail(params: {
  title: string;
  body: string;
  linkUrl?: string;
  imageUrl?: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const { title, body: bodyText, linkUrl, imageUrl, unsubscribeUrl } = params;
  const safeBodyHtml = escapeHtml(bodyText).replace(/\n/g, '<br>');

  const image = imageUrl
    ? `<img src="${encodeURI(imageUrl)}" alt="" style="display: block; max-width: 100%; height: auto; border-radius: 8px; margin: 16px 0;">`
    : '';

  const cta = linkUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 16px 0 8px 0;">${button(linkUrl, 'Learn more')}</td></tr></table>`
    : '';

  const html = renderEmailLayout({
    subject: title,
    preheaderText: bodyText.slice(0, 120),
    body: `
      ${bodyIntro(escapeHtml(title), safeBodyHtml)}
      ${image}
      ${cta}
      ${footerNote(`You received this email from Grails.`, unsubscribeUrl)}
    `,
  });

  return {
    subject: title,
    html,
    text: `${title}\n\n${bodyText}${imageUrl ? `\n\nImage: ${imageUrl}` : ''}${linkUrl ? `\n\nLearn more: ${linkUrl}` : ''}\n\n---\nYou received this email from Grails.\nManage notification preferences: ${unsubscribeUrl}`,
  };
}
