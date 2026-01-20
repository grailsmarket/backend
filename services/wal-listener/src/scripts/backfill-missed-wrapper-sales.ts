#!/usr/bin/env node
/**
 * Backfill script for missed Name Wrapper sales
 *
 * Takes the JSON output from find-missed-wrapper-sales.ts and:
 * 1. Looks up the ENS name by namehash via The Graph
 * 2. Inserts sale records with the actual event date (uses price from JSON)
 * 3. Updates last_sale_price/last_sale_date only if the sale is newer
 *
 * Usage:
 *   npx tsx src/scripts/backfill-missed-wrapper-sales.ts --file missed-sales.json
 *   npx tsx src/scripts/backfill-missed-wrapper-sales.ts --file missed-sales.json --dry-run
 */

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { readFileSync } from 'fs';
import { getPostgresPool, config, createSale } from '../../../shared/src';

// Parse command line args
const args = process.argv.slice(2);
let inputFile: string | undefined;
let dryRun = false;
let delayMs = 500; // Default 500ms between each insert
let batchSize = 10; // Default process 10, then longer pause
let batchPauseMs = 5000; // Default 5 second pause between batches

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    inputFile = args[i + 1];
    i++;
  } else if (args[i] === '--dry-run') {
    dryRun = true;
  } else if (args[i] === '--delay' && args[i + 1]) {
    delayMs = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === '--batch-size' && args[i + 1]) {
    batchSize = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === '--batch-pause' && args[i + 1]) {
    batchPauseMs = parseInt(args[i + 1]);
    i++;
  }
}

if (!inputFile) {
  console.error('Usage: npx tsx src/scripts/backfill-missed-wrapper-sales.ts --file <json-file> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --dry-run              Preview without making changes');
  console.error('  --delay <ms>           Delay between each insert (default: 500ms)');
  console.error('  --batch-size <n>       Process n records, then pause (default: 10)');
  console.error('  --batch-pause <ms>     Pause duration between batches (default: 5000ms)');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const GRAPH_URL = config.theGraph.ensSubgraphUrl;

const client = createPublicClient({
  chain: mainnet,
  transport: http(config.blockchain.rpcUrl),
});

interface MissedSale {
  transactionHash: string;
  blockNumber: string;
  orderHash: string;
  offerer: string;
  recipient: string;
  tokenId: string;
  priceWei: string;
  currencyAddress: string;
  timestamp?: string;
}

/**
 * Resolve namehash to ENS name data via The Graph
 */
async function resolveNamehash(tokenId: string): Promise<{ name: string; expiryDate: Date | null } | null> {
  const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
  const tokenIdAsHex = '0x' + hexString;

  const headers: any = {
    'Content-Type': 'application/json',
  };

  if (config.theGraph.apiKey) {
    headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
  }

  // Query by namehash (domain id)
  const query = `
    query GetENSNameByNamehash($namehash: String!) {
      domain(id: $namehash) {
        id
        name
        labelName
        labelhash
        registration {
          expiryDate
        }
      }
    }
  `;

  try {
    const response = await fetch(GRAPH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: { namehash: tokenIdAsHex }
      }),
    });

    if (!response.ok) {
      console.error(`Graph API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as any;

    if (data.errors) {
      console.error(`Graph query errors:`, data.errors);
      return null;
    }

    if (data.data?.domain) {
      const domain = data.data.domain;
      const name = domain.name || domain.labelName;

      let expiryDate: Date | null = null;
      if (domain.registration?.expiryDate) {
        expiryDate = new Date(parseInt(domain.registration.expiryDate) * 1000);
      }

      return { name, expiryDate };
    }

    return null;
  } catch (error: any) {
    console.error(`Error querying Graph for tokenId ${tokenId}:`, error.message);
    return null;
  }
}


async function backfillMissedSales(): Promise<void> {
  const pool = getPostgresPool();

  console.log('=== Backfill Missed Name Wrapper Sales ===\n');
  console.log(`Input file: ${inputFile}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Throttling: ${delayMs}ms between inserts, ${batchPauseMs}ms pause every ${batchSize} records\n`);

  // Read the JSON file
  let missedSales: MissedSale[];
  try {
    const content = readFileSync(inputFile!, 'utf-8');
    missedSales = JSON.parse(content);
  } catch (error: any) {
    console.error(`Failed to read input file: ${error.message}`);
    await pool.end();
    process.exit(1);
  }

  console.log(`Found ${missedSales.length} missed sales to process`);

  // Estimate time
  if (!dryRun && missedSales.length > 0) {
    const numBatches = Math.ceil(missedSales.length / batchSize);
    const totalDelayMs = (missedSales.length * delayMs) + (numBatches * batchPauseMs);
    const estimatedMinutes = Math.ceil(totalDelayMs / 60000);
    console.log(`Estimated time: ~${estimatedMinutes} minutes (throttling only, excludes RPC/DB time)`);
  }
  console.log('');

  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let updated = 0;
  let errors = 0;

  for (const sale of missedSales) {
    processed++;
    console.log(`\n[${processed}/${missedSales.length}] Processing tx: ${sale.transactionHash}`);

    try {
      // 1. Resolve the name from namehash
      const nameData = await resolveNamehash(sale.tokenId);
      if (!nameData) {
        console.log(`  SKIP: Could not resolve name for tokenId ${sale.tokenId}`);
        skipped++;
        continue;
      }

      console.log(`  Name: ${nameData.name}`);

      // 2. Find or create the ENS name record in our database
      // First try to find by name
      let ensNameResult = await pool.query(
        'SELECT id, last_sale_date FROM ens_names WHERE name = $1',
        [nameData.name]
      );

      let ensNameId: number;
      let currentLastSaleDate: Date | null = null;

      if (ensNameResult.rows.length > 0) {
        ensNameId = ensNameResult.rows[0].id;
        currentLastSaleDate = ensNameResult.rows[0].last_sale_date;
        console.log(`  Found ENS name ID: ${ensNameId}`);
      } else {
        // Try to find by token_id (namehash)
        ensNameResult = await pool.query(
          'SELECT id, last_sale_date FROM ens_names WHERE token_id = $1',
          [sale.tokenId]
        );

        if (ensNameResult.rows.length > 0) {
          ensNameId = ensNameResult.rows[0].id;
          currentLastSaleDate = ensNameResult.rows[0].last_sale_date;
          console.log(`  Found ENS name by token_id: ${ensNameId}`);
        } else {
          console.log(`  SKIP: ENS name not found in database for ${nameData.name}`);
          skipped++;
          continue;
        }
      }

      // 3. Get price and addresses from the JSON data (already extracted by find script)
      const priceWei = sale.priceWei;
      const currencyAddress = (sale.currencyAddress || '0x0000000000000000000000000000000000000000').toLowerCase();
      const sellerAddress = sale.offerer.toLowerCase();
      const buyerAddress = sale.recipient.toLowerCase();

      if (!priceWei || priceWei === '0') {
        console.log(`  SKIP: No price data available`);
        skipped++;
        continue;
      }

      console.log(`  Price: ${priceWei} wei`);

      // 4. Get sale date from timestamp (already fetched by find script) or fetch block
      let saleDate: Date;
      if (sale.timestamp) {
        saleDate = new Date(sale.timestamp);
      } else {
        const block = await client.getBlock({ blockNumber: BigInt(sale.blockNumber) });
        saleDate = new Date(Number(block.timestamp) * 1000);
      }
      console.log(`  Sale date: ${saleDate.toISOString()}`);

      if (dryRun) {
        console.log(`  DRY RUN: Would insert sale and potentially update last_sale`);
        continue;
      }

      // 5. Insert the sale record
      try {
        const saleResult = await createSale({
          ensNameId,
          sellerAddress,
          buyerAddress,
          salePriceWei: priceWei,
          currencyAddress,
          transactionHash: sale.transactionHash.toLowerCase(),
          blockNumber: parseInt(sale.blockNumber),
          orderHash: sale.orderHash.toLowerCase(),
          source: 'opensea',
          saleDate,
        });

        if (saleResult) {
          console.log(`  Inserted sale record ID: ${saleResult.id}`);
          inserted++;
        } else {
          console.log(`  Sale already exists (ON CONFLICT DO NOTHING)`);
        }
      } catch (error: any) {
        console.error(`  Error inserting sale: ${error.message}`);
        errors++;
        continue;
      }

      // 6. Update last_sale_price and last_sale_date only if this sale is newer
      if (!currentLastSaleDate || saleDate > currentLastSaleDate) {
        const updateResult = await pool.query(`
          UPDATE ens_names
          SET last_sale_price = $1,
              last_sale_date = $2,
              updated_at = NOW()
          WHERE id = $3
            AND (last_sale_date IS NULL OR last_sale_date < $2)
        `, [priceWei, saleDate, ensNameId]);

        if (updateResult.rowCount && updateResult.rowCount > 0) {
          console.log(`  Updated last_sale_price and last_sale_date`);
          updated++;
        } else {
          console.log(`  last_sale not updated (a newer sale exists)`);
        }
      } else {
        console.log(`  Skipped last_sale update (current: ${currentLastSaleDate?.toISOString()}, this: ${saleDate.toISOString()})`);
      }

    } catch (error: any) {
      console.error(`  Error processing sale: ${error.message}`);
      errors++;
    }

    // Throttling: delay between each insert
    if (!dryRun && delayMs > 0) {
      await sleep(delayMs);
    }

    // Batch pause: longer delay every N records
    if (!dryRun && batchSize > 0 && processed % batchSize === 0) {
      console.log(`\n  Batch pause (${batchPauseMs}ms) - processed ${processed}/${missedSales.length}...`);
      await sleep(batchPauseMs);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Sales inserted: ${inserted}`);
  console.log(`last_sale updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);

  await pool.end();
}

backfillMissedSales()
  .then(() => {
    console.log('\nBackfill completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nBackfill failed:', error);
    process.exit(1);
  });
