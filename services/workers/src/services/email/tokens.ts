/**
 * Brand tokens for email templates. Mirrors the values in
 * ~/work/grails/app/src/app/globals.css so that emails track the site
 * design without depending on the frontend repo.
 */

export const colors = {
  bg: '#222222',
  card: '#333333',
  cardBorder: '#3f3f3f',
  accent: '#ffdfc0',
  accentMuted: '#7a6a55',
  gold: '#efb100',
  text: '#ffffff',
  textMuted: '#aaaaaa',
  textOnAccent: '#1a1a1a',
  success: '#74fd43',
  info: '#2db5ff',
} as const;

export const fonts = {
  heading: `'Sedan SC', Georgia, 'Times New Roman', serif`,
  body: `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`,
} as const;

export const sizes = {
  containerWidth: 600,
  bodyFont: 16,
  smallFont: 13,
  headingFont: 28,
} as const;
