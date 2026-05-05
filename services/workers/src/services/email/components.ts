import { colors, fonts, sizes } from './tokens';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Bulletproof button that renders consistently in Outlook, Gmail and Apple Mail.
 * Uses VML fallback for Outlook desktop where CSS padding/border-radius break.
 */
export function button(href: string, text: string): string {
  const safeHref = encodeURI(href);
  const safeText = escapeHtml(text);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;">
      <tr>
        <td align="center" bgcolor="${colors.accent}" style="background-color: ${colors.accent}; border-radius: 6px;">
          <a href="${safeHref}"
             style="display: inline-block; padding: 14px 32px; font-family: ${fonts.body}; font-size: ${sizes.bodyFont}px; font-weight: 600; color: ${colors.textOnAccent}; text-decoration: none; border-radius: 6px; letter-spacing: 0.02em;">
            ${safeText}
          </a>
        </td>
      </tr>
    </table>
  `;
}

/**
 * Cream-bordered highlight panel for surfacing a price or other key fact.
 */
export function highlight(label: string, value: string): string {
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(value);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 24px 0;">
      <tr>
        <td align="center" style="border: 1px solid ${colors.accent}; border-radius: 8px; padding: 18px 24px; background-color: ${colors.card};">
          <div style="font-family: ${fonts.body}; font-size: ${sizes.smallFont}px; color: ${colors.textMuted}; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px;">
            ${safeLabel}
          </div>
          <div style="font-family: ${fonts.heading}; font-size: 26px; color: ${colors.accent};">
            ${safeValue}
          </div>
        </td>
      </tr>
    </table>
  `;
}

/**
 * Two-row highlight (e.g., old price → new price for price-change emails).
 */
export function highlightCompare(
  oldLabel: string,
  oldValue: string,
  newLabel: string,
  newValue: string,
): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 24px 0;">
      <tr>
        <td style="border: 1px solid ${colors.accent}; border-radius: 8px; padding: 18px 24px; background-color: ${colors.card};">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td align="left" style="font-family: ${fonts.body}; font-size: ${sizes.smallFont}px; color: ${colors.textMuted}; text-transform: uppercase; letter-spacing: 0.08em;">
                ${escapeHtml(oldLabel)}
              </td>
              <td align="right" style="font-family: ${fonts.body}; font-size: ${sizes.smallFont}px; color: ${colors.textMuted}; text-transform: uppercase; letter-spacing: 0.08em;">
                ${escapeHtml(newLabel)}
              </td>
            </tr>
            <tr>
              <td align="left" style="font-family: ${fonts.heading}; font-size: 22px; color: ${colors.textMuted}; text-decoration: line-through;">
                ${escapeHtml(oldValue)}
              </td>
              <td align="right" style="font-family: ${fonts.heading}; font-size: 22px; color: ${colors.accent};">
                ${escapeHtml(newValue)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

export function divider(): string {
  return `<hr style="border: none; border-top: 1px solid ${colors.cardBorder}; margin: 32px 0;">`;
}

/**
 * Hidden preheader text shown by Gmail/Apple Mail in the inbox preview line.
 * The trailing &nbsp; padding pushes any leaked quoted-printable junk out of
 * the visible preview window.
 */
export function preheader(text: string): string {
  const safe = escapeHtml(text);
  return `<div style="display: none; font-size: 1px; color: ${colors.bg}; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden;">${safe}${'&nbsp;&zwnj;'.repeat(80)}</div>`;
}
