/**
 * Renders every email template with sample fixtures into ./email-previews/
 * so you can iterate on the HTML without sending real SMTP messages.
 *
 *   npm run preview-emails
 *
 * Set FRONTEND_URL to the publicly-hosted origin where email-logo.png lives
 * (defaults to https://grails.app for previews).
 */

// Default the asset/link host to grails.app for previews so the rendered HTML
// can load the logo and links resolve to real pages. Must run before importing
// any module that snapshots config.
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grails.app';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

import * as fs from 'fs';
import * as path from 'path';
import {
  buildNewListingEmail,
  buildPriceChangeEmail,
  buildSaleEmail,
  buildNewOfferEmail,
  buildListingCancelledEmail,
  buildOfferReceivedEmail,
  buildListingSoldEmail,
  buildCommentReceivedEmail,
  buildEmailVerificationEmail,
  buildAdminBroadcastEmail,
  type EmailTemplate,
} from '../services/email';

const ENS = 'metrical.eth';
const URL = 'https://grails.app/metrical.eth';
const UNSUB = 'https://grails.app/settings/notifications';

const fixtures: Array<{ slug: string; label: string; build: () => EmailTemplate }> = [
  {
    slug: 'new-listing',
    label: 'New listing (watcher)',
    build: () => buildNewListingEmail({ ensName: ENS, priceEth: '4.20', listingUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'price-change-drop',
    label: 'Price change — drop (watcher)',
    build: () => buildPriceChangeEmail({ ensName: ENS, oldPriceEth: '5.00', newPriceEth: '3.75', listingUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'price-change-rise',
    label: 'Price change — rise (watcher)',
    build: () => buildPriceChangeEmail({ ensName: ENS, oldPriceEth: '3.00', newPriceEth: '4.50', listingUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'sale',
    label: 'Sale (watcher)',
    build: () => buildSaleEmail({ ensName: ENS, priceEth: '4.20', listingUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'new-offer',
    label: 'New offer (watcher)',
    build: () => buildNewOfferEmail({ ensName: ENS, priceEth: '2.10', offerUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'listing-cancelled',
    label: 'Listing cancelled (ownership change)',
    build: () => buildListingCancelledEmail({ ensName: ENS, listingUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'offer-received',
    label: 'Offer received (owner)',
    build: () => buildOfferReceivedEmail({ ensName: ENS, priceEth: '2.10', offerUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'listing-sold',
    label: 'Listing sold (seller)',
    build: () => buildListingSoldEmail({ ensName: ENS, priceEth: '4.20', saleUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'comment-received',
    label: 'Comment received',
    build: () => buildCommentReceivedEmail({ ensName: ENS, nameUrl: URL, unsubscribeUrl: UNSUB }),
  },
  {
    slug: 'email-verification',
    label: 'Email verification',
    build: () => buildEmailVerificationEmail({ verificationUrl: 'https://grails.app/verify-email?token=preview-token-abc123def456' }),
  },
  {
    slug: 'admin-broadcast-with-cta',
    label: 'Admin broadcast (with CTA + image)',
    build: () => buildAdminBroadcastEmail({
      title: 'Grails Premium is launching',
      body: `We're rolling out Grails Premium in the coming weeks.\n\nPremium includes priority indexing, advanced filters, and bulk-tool quotas.`,
      linkUrl: 'https://grails.app/premium',
      unsubscribeUrl: UNSUB,
    }),
  },
  {
    slug: 'admin-broadcast-plain',
    label: 'Admin broadcast (plain)',
    build: () => buildAdminBroadcastEmail({
      title: 'Scheduled maintenance Sunday 02:00 UTC',
      body: `Grails will be briefly unavailable on Sunday at 02:00 UTC for routine maintenance. Expected downtime is under 10 minutes.`,
      unsubscribeUrl: UNSUB,
    }),
  },
];

const outDir = path.resolve(process.cwd(), 'email-previews');
fs.mkdirSync(outDir, { recursive: true });

const indexEntries: string[] = [];

for (const fixture of fixtures) {
  const tpl = fixture.build();
  const filename = `${fixture.slug}.html`;
  fs.writeFileSync(path.join(outDir, filename), tpl.html, 'utf8');
  indexEntries.push(`
    <section style="margin: 0 0 48px 0;">
      <header style="font-family: -apple-system, sans-serif; padding: 12px 16px; background: #1a1a1a; color: #ffdfc0; border-radius: 8px 8px 0 0;">
        <strong>${escape(fixture.label)}</strong>
        &nbsp;<span style="color: #888; font-weight: normal;">/ ${escape(fixture.slug)}</span>
        &nbsp;<span style="color: #888; font-weight: normal;">— subject:</span>
        <span style="color: #fff;">${escape(tpl.subject)}</span>
      </header>
      <iframe src="${escape(filename)}" style="display: block; width: 100%; height: 720px; border: 1px solid #333; border-top: none; border-radius: 0 0 8px 8px; background: #222;"></iframe>
    </section>
  `);
}

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Grails — Email Template Previews</title>
<style>
  body { margin: 0; padding: 32px; background: #0f0f0f; color: #eee; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  h1 { margin: 0 0 8px 0; font-weight: 500; }
  p { margin: 0 0 32px 0; color: #888; }
</style>
</head>
<body>
<h1>Grails — Email Template Previews</h1>
<p>Sample data only. Edit fixtures in <code>src/scripts/preview-emails.ts</code> and re-run <code>npm run preview-emails</code>.</p>
${indexEntries.join('\n')}
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml, 'utf8');

const indexPath = path.join(outDir, 'index.html');
process.stdout.write(`\nWrote ${fixtures.length} previews to ${outDir}\nOpen: file://${indexPath}\n\n`);

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
