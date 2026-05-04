import { config } from '../../../../shared/src';
import { colors, fonts, sizes } from './tokens';
import { preheader } from './components';

export interface LayoutParams {
  subject: string;
  preheaderText: string;
  /** Inner HTML (heading + body + highlight + cta + footerNote, in any order) */
  body: string;
}

/**
 * Renders the shared HTML shell. Every template builds its `body` string from
 * the helpers in components.ts and passes it here.
 */
export function renderEmailLayout(params: LayoutParams): string {
  const { subject, preheaderText, body } = params;
  const assetBase = config.frontend.url.replace(/\/$/, '');
  const logoUrl = `${assetBase}/email-logo.png`;
  const homeUrl = assetBase;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${escape(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Sedan+SC&display=swap" rel="stylesheet">
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
  body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: ${colors.bg}; }
  a { color: ${colors.accent}; }
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .px { padding-left: 24px !important; padding-right: 24px !important; }
  }
</style>
</head>
<body style="margin: 0; padding: 0; background-color: ${colors.bg}; font-family: ${fonts.body}; color: ${colors.text};">
${preheader(preheaderText)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${colors.bg}" style="background-color: ${colors.bg};">
  <tr>
    <td align="center" style="padding: 32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${sizes.containerWidth}" class="container" style="width: ${sizes.containerWidth}px; max-width: 100%;">
        <tr>
          <td align="center" style="padding: 16px 0 32px 0;">
            <a href="${escape(homeUrl)}" style="text-decoration: none;">
              <img src="${escape(logoUrl)}" alt="Grails" width="180" style="display: block; width: 180px; max-width: 60%; height: auto;">
            </a>
          </td>
        </tr>
        <tr>
          <td bgcolor="${colors.card}" class="px" style="background-color: ${colors.card}; border: 1px solid ${colors.cardBorder}; border-radius: 12px; padding: 40px 48px; color: ${colors.text}; font-family: ${fonts.body}; font-size: ${sizes.bodyFont}px; line-height: 1.55;">
            ${body}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 24px 16px 0 16px; font-family: ${fonts.body}; font-size: 12px; color: ${colors.textMuted}; line-height: 1.6;">
            <a href="${escape(homeUrl)}" style="color: ${colors.textMuted}; text-decoration: none;">grails.app</a>
            &nbsp;·&nbsp; ENS Manager &amp; Market
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * Standard heading + intro paragraph block used by most templates.
 */
export function bodyIntro(heading: string, intro: string): string {
  return `
    <h1 style="margin: 0 0 16px 0; font-family: ${fonts.heading}; font-weight: 400; font-size: ${sizes.headingFont}px; color: ${colors.text}; line-height: 1.2; letter-spacing: 0.02em;">
      ${heading}
    </h1>
    <p style="margin: 0 0 8px 0; font-family: ${fonts.body}; font-size: ${sizes.bodyFont}px; color: ${colors.text}; line-height: 1.55;">
      ${intro}
    </p>
  `;
}

/**
 * Standard footer note + manage-preferences link block.
 */
export function footerNote(note: string, unsubscribeUrl: string): string {
  return `
    <hr style="border: none; border-top: 1px solid ${colors.cardBorder}; margin: 32px 0 20px 0;">
    <p style="margin: 0; font-family: ${fonts.body}; font-size: 12px; color: ${colors.textMuted}; line-height: 1.6;">
      ${note}
      &nbsp;<a href="${encodeURI(unsubscribeUrl)}" style="color: ${colors.accent}; text-decoration: underline;">Manage notification preferences</a>.
    </p>
  `;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
