/**
 * Diagnostic script to find discrepancies between Elasticsearch and PostgreSQL
 * for listing status (names showing as 'unlisted' in ES but having active listings in DB)
 */

import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { config, getPostgresPool } from '../../../shared/src';

async function checkListingDrift() {
  console.log('=== Listing Status Drift Analysis ===\n');

  const pool = getPostgresPool();
  const esClient = new ElasticsearchClient({
    node: config.elasticsearch.url,
  });

  try {
    // Step 1: Get all ENS names with active listings from the database
    console.log('Fetching names with active listings from database...');
    const dbResult = await pool.query(`
      SELECT
        en.id,
        en.token_id,
        en.name,
        en.owner_address,
        l.id as listing_id,
        l.status as listing_status,
        l.price_wei,
        l.created_at as listing_created_at,
        l.updated_at as listing_updated_at
      FROM ens_names en
      INNER JOIN listings l ON l.ens_name_id = en.id
      WHERE l.status = 'active'
      ORDER BY l.created_at DESC
    `);

    console.log(`Found ${dbResult.rows.length} names with active listings in database\n`);

    if (dbResult.rows.length === 0) {
      console.log('No active listings found in database.');
      return;
    }

    // Step 2: Check each one in Elasticsearch
    let driftCount = 0;
    let matchCount = 0;
    let missingCount = 0;
    const driftRecords: any[] = [];

    console.log('Checking Elasticsearch status for each...\n');

    for (const dbRow of dbResult.rows) {
      try {
        const esResult = await esClient.get({
          index: config.elasticsearch.index,
          id: dbRow.id.toString(),
        });

        const esStatus = (esResult._source as any)?.status;

        if (esStatus === 'active') {
          matchCount++;
        } else {
          driftCount++;
          driftRecords.push({
            id: dbRow.id,
            name: dbRow.name,
            dbListingStatus: dbRow.listing_status,
            esStatus: esStatus || 'undefined',
            listingId: dbRow.listing_id,
            listingCreatedAt: dbRow.listing_created_at,
            listingUpdatedAt: dbRow.listing_updated_at,
            priceWei: dbRow.price_wei,
          });
        }
      } catch (error: any) {
        if (error.meta?.statusCode === 404) {
          missingCount++;
          driftRecords.push({
            id: dbRow.id,
            name: dbRow.name,
            dbListingStatus: dbRow.listing_status,
            esStatus: 'NOT_IN_ES',
            listingId: dbRow.listing_id,
            listingCreatedAt: dbRow.listing_created_at,
            listingUpdatedAt: dbRow.listing_updated_at,
            priceWei: dbRow.price_wei,
          });
        } else {
          console.error(`Error checking ${dbRow.name}:`, error.message);
        }
      }
    }

    // Step 3: Report results
    console.log('=== Results ===\n');
    console.log(`Total active listings in DB: ${dbResult.rows.length}`);
    console.log(`Correctly synced to ES:      ${matchCount}`);
    console.log(`Drift (wrong status in ES):  ${driftCount}`);
    console.log(`Missing from ES entirely:    ${missingCount}`);

    if (driftRecords.length > 0) {
      console.log('\n=== Drift Details (first 20) ===\n');

      for (const record of driftRecords.slice(0, 20)) {
        console.log(`Name: ${record.name}`);
        console.log(`  DB ID: ${record.id}, Listing ID: ${record.listingId}`);
        console.log(`  DB Status: ${record.dbListingStatus}, ES Status: ${record.esStatus}`);
        console.log(`  Listing Created: ${record.listingCreatedAt}`);
        console.log(`  Listing Updated: ${record.listingUpdatedAt}`);
        console.log(`  Price: ${record.priceWei} wei`);
        console.log('');
      }

      if (driftRecords.length > 20) {
        console.log(`... and ${driftRecords.length - 20} more\n`);
      }

      // Analyze patterns
      console.log('=== Pattern Analysis ===\n');

      // Check if drift is concentrated in recent listings
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const recentDrift = driftRecords.filter(r => new Date(r.listingCreatedAt) > oneHourAgo);
      const dayOldDrift = driftRecords.filter(r => new Date(r.listingCreatedAt) > oneDayAgo);

      console.log(`Drift from last hour:  ${recentDrift.length}`);
      console.log(`Drift from last 24h:   ${dayOldDrift.length}`);
      console.log(`Drift older than 24h:  ${driftRecords.length - dayOldDrift.length}`);
    }

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await pool.end();
  }
}

checkListingDrift();
