#!/usr/bin/env tsx

/**
 * Validate and Fix ENS Data from The Graph
 *
 * This comprehensive script:
 * 1. Fetches all ENS names from the database (excluding placeholders/subnames)
 * 2. Queries The Graph ENS subgraph by name in batches
 * 3. Compares critical data points:
 *    - token_id (derived from labelhash or wrapped domain id)
 *    - owner_address (wrappedOwner if wrapped, else registrant/owner)
 *    - registrant
 *    - expiry_date
 *    - registration_date
 * 4. Updates records that are stale or incorrect
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node --max-old-space-size=4096 dist/wal-listener/src/scripts/validate-ens-data.js [options]
 *
 * Options:
 *   --dry-run           Don't update database, just report
 *   --limit N           Limit to N records (default: 100000)
 *   --batch-size N      Query N names per Graph request (default: 50)
 *   --offset N          Start at offset N (default: 0)
 *   --verbose           Show all records, not just mismatches
 *   --fix-token-ids     Also fix token IDs (default: false, as this is more complex)
 */

import { getPostgresPool } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const GRACE_PERIOD_SECONDS = 90 * 24 * 60 * 60; // 90 days in seconds

interface EnsNameRecord {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
  registrant: string | null;
  expiry_date: Date | null;
  registration_date: Date | null;
}

interface GraphDomainData {
  name: string;
  labelhash: string;
  id: string; // namehash - used for wrapped token_id
  owner: string;
  wrappedOwner: string | null;
  registrant: string | null;
  expiryDate: string | null;
  registrationDate: string | null;
}

interface ValidationResult {
  id: number;
  name: string;
  mismatches: string[];
  updates: {
    owner_address?: string;
    registrant?: string;
    expiry_date?: Date;
    registration_date?: Date;
    token_id?: string;
  };
}

// Convert hex to decimal string for token_id
function hexToDecimal(hex: string): string {
  const hexStr = hex.startsWith('0x') ? hex.slice(2) : hex;
  const paddedHex = hexStr.padStart(64, '0');
  let result = BigInt(0);
  for (let i = 0; i < paddedHex.length; i++) {
    const digit = paddedHex[i];
    const value = parseInt(digit, 16);
    result = result * BigInt(16) + BigInt(value);
  }
  return result.toString();
}

// Query The Graph for multiple domains by names in a single batch
async function queryGraphForNamesBatch(names: string[]): Promise<Map<string, GraphDomainData>> {
  const query = `
    query GetDomainsByNames($names: [String!]!) {
      domains(where: { name_in: $names }) {
        id
        name
        labelhash
        owner {
          id
        }
        wrappedOwner {
          id
        }
        registrant {
          id
        }
        registration {
          expiryDate
          registrationDate
        }
      }
    }
  `;

  try {
    const response = await fetch(GRAPH_ENS_SUBGRAPH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          names: names,
        },
      }),
    });

    if (!response.ok) {
      console.error(`Graph API error: ${response.status} ${response.statusText}`);
      return new Map();
    }

    const result: any = await response.json();

    if (result.errors) {
      console.error('GraphQL errors:', result.errors);
      return new Map();
    }

    const resultsMap = new Map<string, GraphDomainData>();

    if (result.data?.domains) {
      for (const domain of result.data.domains) {
        resultsMap.set(domain.name.toLowerCase(), {
          name: domain.name,
          id: domain.id,
          labelhash: domain.labelhash,
          owner: domain.owner?.id || null,
          wrappedOwner: domain.wrappedOwner?.id || null,
          registrant: domain.registrant?.id || null,
          expiryDate: domain.registration?.expiryDate || null,
          registrationDate: domain.registration?.registrationDate || null,
        });
      }
    }

    return resultsMap;
  } catch (error: any) {
    console.error(`Error querying The Graph: ${error.message}`);
    return new Map();
  }
}

// Sleep helper for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Determine correct owner address based on wrapper status
function getCorrectOwner(graphData: GraphDomainData): string | null {
  const ownerAddress = graphData.owner?.toLowerCase();
  const isWrapped = ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase();

  if (isWrapped && graphData.wrappedOwner) {
    return graphData.wrappedOwner.toLowerCase();
  } else if (graphData.registrant) {
    return graphData.registrant.toLowerCase();
  } else if (graphData.owner) {
    return graphData.owner.toLowerCase();
  }
  return null;
}

// Determine correct token_id based on wrapper status and expiry
function getCorrectTokenId(graphData: GraphDomainData): string {
  const ownerAddress = graphData.owner?.toLowerCase();
  const isWrapped = ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase();

  // Check if fully expired (past expiry + 90 day grace period)
  // During grace period, the wrapped token_id should still be used
  const expiryTimestamp = graphData.expiryDate ? parseInt(graphData.expiryDate) : 0;
  const graceEndTimestamp = expiryTimestamp + GRACE_PERIOD_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const isPastGracePeriod = nowSeconds > graceEndTimestamp;

  // If wrapped and not past grace period, use namehash (domain.id)
  // Only after grace period ends does the token revert to labelhash
  if (isWrapped && !isPastGracePeriod) {
    return hexToDecimal(graphData.id);
  }
  return hexToDecimal(graphData.labelhash);
}

// Compare a single record against Graph data and return validation result
function validateRecord(record: EnsNameRecord, graphData: GraphDomainData, fixTokenIds: boolean): ValidationResult | null {
  const mismatches: string[] = [];
  const updates: ValidationResult['updates'] = {};

  // 1. Check owner_address
  const correctOwner = getCorrectOwner(graphData);
  if (correctOwner && record.owner_address?.toLowerCase() !== correctOwner) {
    mismatches.push(`owner_address: ${record.owner_address} → ${correctOwner}`);
    updates.owner_address = correctOwner;
  }

  // 2. Check registrant
  const correctRegistrant = graphData.registrant?.toLowerCase() || null;
  const currentRegistrant = record.registrant?.toLowerCase() || null;
  if (correctRegistrant !== currentRegistrant) {
    mismatches.push(`registrant: ${currentRegistrant || 'NULL'} → ${correctRegistrant || 'NULL'}`);
    updates.registrant = correctRegistrant || undefined;
  }

  // 3. Check expiry_date
  if (graphData.expiryDate) {
    const graphExpiryDate = new Date(parseInt(graphData.expiryDate) * 1000);
    const dbExpiryDate = record.expiry_date;

    // Check if Graph has a newer/different expiry
    if (!dbExpiryDate || Math.abs(graphExpiryDate.getTime() - dbExpiryDate.getTime()) > 1000) {
      // Allow 1 second tolerance for rounding
      const isNewer = !dbExpiryDate || graphExpiryDate.getTime() > dbExpiryDate.getTime();
      if (isNewer || !dbExpiryDate) {
        mismatches.push(`expiry_date: ${dbExpiryDate?.toISOString() || 'NULL'} → ${graphExpiryDate.toISOString()}`);
        updates.expiry_date = graphExpiryDate;
      }
    }
  }

  // 4. Check registration_date
  if (graphData.registrationDate) {
    const graphRegistrationDate = new Date(parseInt(graphData.registrationDate) * 1000);
    const dbRegistrationDate = record.registration_date;

    if (!dbRegistrationDate || Math.abs(graphRegistrationDate.getTime() - dbRegistrationDate.getTime()) > 1000) {
      mismatches.push(`registration_date: ${dbRegistrationDate?.toISOString() || 'NULL'} → ${graphRegistrationDate.toISOString()}`);
      updates.registration_date = graphRegistrationDate;
    }
  }

  // 5. Check token_id (only if --fix-token-ids is enabled)
  if (fixTokenIds && graphData.labelhash) {
    const correctTokenId = getCorrectTokenId(graphData);
    if (record.token_id !== correctTokenId) {
      mismatches.push(`token_id: ${record.token_id.substring(0, 20)}... → ${correctTokenId.substring(0, 20)}...`);
      updates.token_id = correctTokenId;
    }
  }

  if (mismatches.length > 0) {
    return {
      id: record.id,
      name: record.name,
      mismatches,
      updates,
    };
  }

  return null;
}

async function validateEnsData(options: {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
  verbose?: boolean;
  fixTokenIds?: boolean;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun ?? false;
  const limit = options.limit ?? 100000;
  const batchSize = options.batchSize ?? 50;
  const offset = options.offset ?? 0;
  const verbose = options.verbose ?? false;
  const fixTokenIds = options.fixTokenIds ?? false;

  try {
    console.log('\n=== Validating ENS Data Against The Graph ===\n');
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`Verbose: ${verbose ? 'YES' : 'NO'}`);
    console.log(`Fix token IDs: ${fixTokenIds ? 'YES' : 'NO'}\n`);

    // Fetch ENS name records (excluding placeholders and subnames)
    console.log('Fetching ENS name records...\n');

    const query = `
      SELECT
        id,
        name,
        token_id,
        owner_address,
        registrant,
        expiry_date,
        registration_date
      FROM ens_names
      WHERE name NOT LIKE '#%'
        AND name NOT LIKE 'token-%'
        AND name NOT LIKE '%.%.eth'
        AND name NOT LIKE '[%].eth'
        AND name LIKE '%.eth'
    AND registrant = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401'
      ORDER BY id
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);
    const records: EnsNameRecord[] = result.rows;

    console.log(`Found ${records.length} ENS name records to validate\n`);

    if (records.length === 0) {
      console.log('No records to process!');
      await pool.end();
      return;
    }

    // Show sample records
    console.log('Sample records:');
    records.slice(0, 3).forEach((r) => {
      console.log(`  ID ${r.id}: ${r.name}`);
      console.log(`    Owner: ${r.owner_address}`);
      console.log(`    Registrant: ${r.registrant || 'NULL'}`);
      console.log(`    Expiry: ${r.expiry_date?.toISOString() || 'NULL'}`);
    });
    console.log('');

    // Process statistics
    let processed = 0;
    let valid = 0;
    let invalid = 0;
    let updated = 0;
    let notFound = 0;
    let errors = 0;

    // Mismatch counters by field
    const fieldMismatches = {
      owner_address: 0,
      registrant: 0,
      expiry_date: 0,
      registration_date: 0,
      token_id: 0,
    };

    const validationResults: ValidationResult[] = [];

    console.log('Starting validation...\n');

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      console.log(`Processing batch ${batchNum} (records ${i + 1}-${Math.min(i + batchSize, records.length)})...`);

      // Collect names for this batch
      const nameMap = new Map<string, EnsNameRecord>();
      const namesArray: string[] = [];

      for (const record of batch) {
        nameMap.set(record.name.toLowerCase(), record);
        namesArray.push(record.name);
      }

      // Query The Graph for all names in this batch
      const domainDataMap = await queryGraphForNamesBatch(namesArray);

      // Process results
      for (const [nameLower, record] of nameMap.entries()) {
        processed++;

        const graphData = domainDataMap.get(nameLower);

        if (!graphData) {
          if (verbose) {
            console.log(`  ⚠️  ${record.name} - Not found in The Graph`);
          }
          notFound++;
          continue;
        }

        const validationResult = validateRecord(record, graphData, fixTokenIds);

        if (validationResult) {
          invalid++;
          validationResults.push(validationResult);

          console.log(`  ❌ ${record.name}`);
          for (const mismatch of validationResult.mismatches) {
            console.log(`     ${mismatch}`);

            // Track field-level mismatches
            if (mismatch.startsWith('owner_address:')) fieldMismatches.owner_address++;
            if (mismatch.startsWith('registrant:')) fieldMismatches.registrant++;
            if (mismatch.startsWith('expiry_date:')) fieldMismatches.expiry_date++;
            if (mismatch.startsWith('registration_date:')) fieldMismatches.registration_date++;
            if (mismatch.startsWith('token_id:')) fieldMismatches.token_id++;
          }

          // Apply updates if not dry run
          if (!dryRun && Object.keys(validationResult.updates).length > 0) {
            try {
              const setClauses: string[] = [];
              const values: any[] = [];
              let paramIndex = 1;

              if (validationResult.updates.owner_address !== undefined) {
                setClauses.push(`owner_address = $${paramIndex++}`);
                values.push(validationResult.updates.owner_address);
              }
              if (validationResult.updates.registrant !== undefined) {
                setClauses.push(`registrant = $${paramIndex++}`);
                values.push(validationResult.updates.registrant || null);
              }
              if (validationResult.updates.expiry_date !== undefined) {
                setClauses.push(`expiry_date = $${paramIndex++}`);
                values.push(validationResult.updates.expiry_date);
              }
              if (validationResult.updates.registration_date !== undefined) {
                setClauses.push(`registration_date = $${paramIndex++}`);
                values.push(validationResult.updates.registration_date);
              }
              if (validationResult.updates.token_id !== undefined) {
                setClauses.push(`token_id = $${paramIndex++}`);
                values.push(validationResult.updates.token_id);
              }

              setClauses.push(`updated_at = NOW()`);
              values.push(record.id);

              const updateQuery = `
                UPDATE ens_names
                SET ${setClauses.join(', ')}
                WHERE id = $${paramIndex}
              `;

              await pool.query(updateQuery, values);
              updated++;
            } catch (updateError: any) {
              console.error(`     ❌ Failed to update: ${updateError.message}`);
              errors++;
            }
          }
        } else {
          valid++;
          if (verbose) {
            console.log(`  ✅ ${record.name} - Valid`);
          }
        }
      }

      // Rate limiting
      await sleep(200);

      // Progress update every 10 batches
      if (batchNum % 10 === 0) {
        const pct = ((processed / records.length) * 100).toFixed(1);
        console.log(`\n  Progress: ${processed}/${records.length} (${pct}%) - Valid: ${valid}, Invalid: ${invalid}\n`);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('=== Validation Summary ===');
    console.log('='.repeat(60) + '\n');

    console.log(`Total processed:    ${processed}`);
    console.log(`Valid records:      ${valid} (${((valid / processed) * 100).toFixed(1)}%)`);
    console.log(`Invalid records:    ${invalid} (${((invalid / processed) * 100).toFixed(1)}%)`);
    console.log(`Not found in Graph: ${notFound}`);
    console.log(`Update errors:      ${errors}`);

    if (!dryRun) {
      console.log(`Successfully updated: ${updated}`);
    }

    console.log('\nMismatches by field:');
    console.log(`  owner_address:     ${fieldMismatches.owner_address}`);
    console.log(`  registrant:        ${fieldMismatches.registrant}`);
    console.log(`  expiry_date:       ${fieldMismatches.expiry_date}`);
    console.log(`  registration_date: ${fieldMismatches.registration_date}`);
    if (fixTokenIds) {
      console.log(`  token_id:          ${fieldMismatches.token_id}`);
    }

    if (dryRun) {
      console.log('\n⚠️  DRY RUN - No changes were made to the database');
      console.log('Run without --dry-run to apply updates\n');
    } else {
      console.log('\n✅ Database has been updated!\n');
    }

    // Export results
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = `validate-ens-data-${timestamp}.json`;

    const results = {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      options: {
        limit,
        batchSize,
        offset,
        fixTokenIds,
      },
      summary: {
        total: processed,
        valid,
        invalid,
        notFound,
        errors,
        updated: dryRun ? 0 : updated,
      },
      fieldMismatches,
      invalidRecords: validationResults.map((r) => ({
        id: r.id,
        name: r.name,
        mismatches: r.mismatches,
      })),
    };

    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results exported to: ${outputFile}\n`);

  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
  verbose?: boolean;
  fixTokenIds?: boolean;
} = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    options.dryRun = true;
  } else if (args[i] === '--verbose') {
    options.verbose = true;
  } else if (args[i] === '--fix-token-ids') {
    options.fixTokenIds = true;
  } else if (args[i] === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--batch-size' && args[i + 1]) {
    options.batchSize = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--offset' && args[i + 1]) {
    options.offset = parseInt(args[i + 1], 10);
    i++;
  }
}

// Main execution
validateEnsData(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
