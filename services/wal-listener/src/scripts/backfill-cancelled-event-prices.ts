import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Backfill price_wei and currency_address for cancelled events
 *
 * This script updates existing offer_cancelled and listing_cancelled events
 * to include the price and currency information from the related offer or listing.
 */
async function backfillCancelledEventPrices() {
  const pool = getPostgresPool();

  console.log('=== Backfill Cancelled Event Prices ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (database will be updated)'}\n`);

  if (DRY_RUN) {
    console.log('🔍 Running in dry-run mode - no database updates will be performed\n');
  } else {
    console.log('⚠️  Running in LIVE mode - database will be updated!\n');
  }

  try {
    // 1. Backfill offer_cancelled events
    console.log('Processing offer_cancelled events...\n');

    const offerCancelledQuery = `
      SELECT
        ah.id,
        ah.ens_name_id,
        ah.metadata->>'offer_id' as offer_id,
        ah.price_wei as current_price,
        ah.currency_address as current_currency
      FROM activity_history ah
      WHERE ah.event_type = 'offer_cancelled'
        AND ah.metadata->>'offer_id' IS NOT NULL
        AND (ah.price_wei IS NULL OR ah.currency_address IS NULL)
      ORDER BY ah.id
    `;

    const offerResults = await pool.query(offerCancelledQuery);
    console.log(`Found ${offerResults.rows.length} offer_cancelled events to update\n`);

    let offerUpdated = 0;
    let offerNotFound = 0;
    let offerErrors = 0;

    for (const row of offerResults.rows) {
      try {
        // Fetch the offer details
        const offerQuery = `
          SELECT offer_amount_wei, currency_address
          FROM offers
          WHERE id = $1
        `;
        const offerResult = await pool.query(offerQuery, [row.offer_id]);

        if (offerResult.rows.length === 0) {
          console.log(`  [SKIP] Activity ${row.id} - Offer ${row.offer_id} not found`);
          offerNotFound++;
          continue;
        }

        const offer = offerResult.rows[0];

        console.log(`  [UPDATE] Activity ${row.id}`);
        console.log(`    Offer ID: ${row.offer_id}`);
        console.log(`    Price: ${offer.offer_amount_wei}`);
        console.log(`    Currency: ${offer.currency_address}`);

        if (!DRY_RUN) {
          await pool.query(
            `UPDATE activity_history
             SET price_wei = $1, currency_address = $2
             WHERE id = $3`,
            [offer.offer_amount_wei, offer.currency_address, row.id]
          );
        } else {
          console.log(`    [DRY RUN] Would update activity_history`);
        }

        offerUpdated++;
      } catch (error: any) {
        console.error(`  [ERROR] Activity ${row.id} - ${error.message}`);
        offerErrors++;
      }
    }

    console.log(`\nOffer Cancellations Summary:`);
    console.log(`  Updated: ${offerUpdated}`);
    console.log(`  Not Found: ${offerNotFound}`);
    console.log(`  Errors: ${offerErrors}\n`);

    // 2. Backfill listing_cancelled events
    console.log('Processing listing_cancelled events...\n');

    const listingCancelledQuery = `
      SELECT
        ah.id,
        ah.ens_name_id,
        ah.metadata->>'listing_id' as listing_id,
        ah.price_wei as current_price,
        ah.currency_address as current_currency
      FROM activity_history ah
      WHERE ah.event_type = 'listing_cancelled'
        AND ah.metadata->>'listing_id' IS NOT NULL
        AND (ah.price_wei IS NULL OR ah.currency_address IS NULL)
      ORDER BY ah.id
    `;

    const listingResults = await pool.query(listingCancelledQuery);
    console.log(`Found ${listingResults.rows.length} listing_cancelled events to update\n`);

    let listingUpdated = 0;
    let listingNotFound = 0;
    let listingErrors = 0;

    for (const row of listingResults.rows) {
      try {
        // Fetch the listing details
        const listingQuery = `
          SELECT price_wei, currency_address
          FROM listings
          WHERE id = $1
        `;
        const listingResult = await pool.query(listingQuery, [row.listing_id]);

        if (listingResult.rows.length === 0) {
          console.log(`  [SKIP] Activity ${row.id} - Listing ${row.listing_id} not found`);
          listingNotFound++;
          continue;
        }

        const listing = listingResult.rows[0];

        console.log(`  [UPDATE] Activity ${row.id}`);
        console.log(`    Listing ID: ${row.listing_id}`);
        console.log(`    Price: ${listing.price_wei}`);
        console.log(`    Currency: ${listing.currency_address}`);

        if (!DRY_RUN) {
          await pool.query(
            `UPDATE activity_history
             SET price_wei = $1, currency_address = $2
             WHERE id = $3`,
            [listing.price_wei, listing.currency_address, row.id]
          );
        } else {
          console.log(`    [DRY RUN] Would update activity_history`);
        }

        listingUpdated++;
      } catch (error: any) {
        console.error(`  [ERROR] Activity ${row.id} - ${error.message}`);
        listingErrors++;
      }
    }

    console.log(`\nListing Cancellations Summary:`);
    console.log(`  Updated: ${listingUpdated}`);
    console.log(`  Not Found: ${listingNotFound}`);
    console.log(`  Errors: ${listingErrors}\n`);

    console.log('\n=== Backfill Complete ===');
    console.log(`Total Events Updated: ${offerUpdated + listingUpdated}`);
    console.log(`Total Not Found: ${offerNotFound + listingNotFound}`);
    console.log(`Total Errors: ${offerErrors + listingErrors}`);

    await pool.end();
  } catch (error) {
    console.error('Script failed:', error);
    await pool.end();
    process.exit(1);
  }
}

// Run the script
backfillCancelledEventPrices()
  .then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
