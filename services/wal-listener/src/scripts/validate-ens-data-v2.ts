#!/usr/bin/env tsx

/**
 * Validate and Fix ENS Data from The Graph (v2)
 *
 * Compares ENS name data in PostgreSQL against The Graph ENS subgraph and
 * fixes mismatches for: owner_address, registrant, expiry_date,
 * registration_date, and optionally token_id.
 *
 * Improvements over v1:
 * - Keyset pagination (WHERE id > lastId) instead of OFFSET
 * - Streams from DB instead of loading everything upfront
 * - Batched DB updates instead of individual UPDATE per mismatch
 * - Concurrent Graph API requests (configurable parallelism)
 * - Resumable via checkpoint file
 * - Graceful shutdown on SIGINT/SIGTERM
 * - Progress with ETA
 * - Streams results to file instead of accumulating in memory
 *
 * Usage:
 *   npx tsx src/scripts/validate-ens-data-v2.ts [options]
 *
 * Options:
 *   --dry-run             Don't update database, just report
 *   --limit N             Max records to process (default: all)
 *   --graph-batch-size N  Names per Graph request (default: 50)
 *   --graph-concurrency N Parallel Graph requests (default: 3)
 *   --verbose             Show all records, not just mismatches
 *   --fix-token-ids       Also fix token IDs
 *   --resume              Resume from last checkpoint
 *   --from N              Start from specific DB id
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import * as fs from 'fs';
import * as path from 'path';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const GRACE_PERIOD_SECONDS = 90 * 24 * 60 * 60;

const DB_BATCH_SIZE = 500;       // Records fetched from DB per iteration
const UPDATE_BATCH_SIZE = 50;    // Updates batched into single transaction
const MAX_GRAPH_RETRIES = 3;
const GRAPH_RETRY_DELAY_MS = 1000;
const CHECKPOINT_INTERVAL = 5;   // Save checkpoint every N DB batches

const CHECKPOINT_FILE = path.join(process.cwd(), 'data', 'validate-checkpoint.json');
const RESULTS_FILE = path.join(process.cwd(), 'data', 'validate-results.jsonl');

// --- Types ---

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
  id: string;
  owner: string;
  wrappedOwner: string | null;
  registrant: string | null;
  expiryDate: string | null;
  registrationDate: string | null;
}

interface PendingUpdate {
  id: number;
  updates: Record<string, any>;
}

interface Checkpoint {
  lastId: number;
  processed: number;
  startedAt: string;
}

interface Stats {
  processed: number;
  valid: number;
  invalid: number;
  updated: number;
  notFound: number;
  errors: number;
  fieldMismatches: Record<string, number>;
}

// --- Shared state for graceful shutdown ---

let currentLastId = 0;
let currentProcessed = 0;
let shuttingDown = false;

// --- Utility functions ---

function hexToDecimal(hex: string): string {
  const cleaned = hex.startsWith('0x') ? hex : '0x' + hex;
  return BigInt(cleaned).toString();
}

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

function getCorrectTokenId(graphData: GraphDomainData): string {
  const ownerAddress = graphData.owner?.toLowerCase();
  const isWrapped = ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase();

  const expiryTimestamp = graphData.expiryDate ? parseInt(graphData.expiryDate) : 0;
  const graceEndTimestamp = expiryTimestamp + GRACE_PERIOD_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const isPastGracePeriod = nowSeconds > graceEndTimestamp;

  if (isWrapped && !isPastGracePeriod) {
    return hexToDecimal(graphData.id);
  }
  return hexToDecimal(graphData.labelhash);
}

// --- Graph API with retry ---

async function queryGraphBatch(names: string[]): Promise<Map<string, GraphDomainData>> {
  const query = `
    query GetDomainsByNames($names: [String!]!) {
      domains(where: { name_in: $names }) {
        id
        name
        labelhash
        owner { id }
        wrappedOwner { id }
        registrant { id }
        registration {
          expiryDate
          registrationDate
        }
      }
    }
  `;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_GRAPH_RETRIES; attempt++) {
    try {
      const response = await fetch(GRAPH_ENS_SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { names } }),
      });

      if (!response.ok) {
        throw new Error(`Graph API error: ${response.status} ${response.statusText}`);
      }

      const result: any = await response.json();

      if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
      }

      const map = new Map<string, GraphDomainData>();
      if (result.data?.domains) {
        for (const domain of result.data.domains) {
          map.set(domain.name.toLowerCase(), {
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
      return map;
    } catch (error: any) {
      lastError = error;
      if (attempt < MAX_GRAPH_RETRIES) {
        const delay = GRAPH_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`  Graph query failed (attempt ${attempt}/${MAX_GRAPH_RETRIES}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`  Graph query failed after ${MAX_GRAPH_RETRIES} attempts: ${lastError?.message}`);
  return new Map();
}

// --- Concurrent Graph queries ---

async function queryGraphConcurrent(
  records: EnsNameRecord[],
  graphBatchSize: number,
  concurrency: number,
): Promise<Map<string, GraphDomainData>> {
  const combined = new Map<string, GraphDomainData>();

  // Split records into Graph-sized batches
  const batches: string[][] = [];
  for (let i = 0; i < records.length; i += graphBatchSize) {
    batches.push(records.slice(i, i + graphBatchSize).map(r => r.name));
  }

  // Process batches with limited concurrency
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(names => queryGraphBatch(names)));

    for (const resultMap of results) {
      for (const [key, value] of resultMap) {
        combined.set(key, value);
      }
    }

    // Small delay between concurrent groups
    if (i + concurrency < batches.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return combined;
}

// --- Validation ---

function validateRecord(
  record: EnsNameRecord,
  graphData: GraphDomainData,
  fixTokenIds: boolean,
): { mismatches: string[]; updates: Record<string, any> } | null {
  const mismatches: string[] = [];
  const updates: Record<string, any> = {};

  // owner_address
  const correctOwner = getCorrectOwner(graphData);
  if (correctOwner && record.owner_address?.toLowerCase() !== correctOwner) {
    mismatches.push(`owner_address: ${record.owner_address} -> ${correctOwner}`);
    updates.owner_address = correctOwner;
  }

  // registrant
  const correctRegistrant = graphData.registrant?.toLowerCase() || null;
  const currentRegistrant = record.registrant?.toLowerCase() || null;
  if (correctRegistrant !== currentRegistrant) {
    mismatches.push(`registrant: ${currentRegistrant || 'NULL'} -> ${correctRegistrant || 'NULL'}`);
    updates.registrant = correctRegistrant;
  }

  // expiry_date
  if (graphData.expiryDate) {
    const graphExpiry = new Date(parseInt(graphData.expiryDate) * 1000);
    const dbExpiry = record.expiry_date;
    if (!dbExpiry || Math.abs(graphExpiry.getTime() - dbExpiry.getTime()) > 1000) {
      const isNewer = !dbExpiry || graphExpiry.getTime() > dbExpiry.getTime();
      if (isNewer || !dbExpiry) {
        mismatches.push(`expiry_date: ${dbExpiry?.toISOString() || 'NULL'} -> ${graphExpiry.toISOString()}`);
        updates.expiry_date = graphExpiry;
      }
    }
  }

  // registration_date
  if (graphData.registrationDate) {
    const graphRegDate = new Date(parseInt(graphData.registrationDate) * 1000);
    const dbRegDate = record.registration_date;
    if (!dbRegDate || Math.abs(graphRegDate.getTime() - dbRegDate.getTime()) > 1000) {
      mismatches.push(`registration_date: ${dbRegDate?.toISOString() || 'NULL'} -> ${graphRegDate.toISOString()}`);
      updates.registration_date = graphRegDate;
    }
  }

  // token_id
  if (fixTokenIds && graphData.labelhash) {
    const correctTokenId = getCorrectTokenId(graphData);
    if (record.token_id !== correctTokenId) {
      mismatches.push(`token_id: ${record.token_id.substring(0, 20)}... -> ${correctTokenId.substring(0, 20)}...`);
      updates.token_id = correctTokenId;
    }
  }

  return mismatches.length > 0 ? { mismatches, updates } : null;
}

// --- Batched DB updates ---

async function flushUpdates(pool: any, pendingUpdates: PendingUpdate[]): Promise<number> {
  if (pendingUpdates.length === 0) return 0;

  const client = await pool.connect();
  let updated = 0;

  try {
    await client.query('BEGIN');

    for (const { id, updates } of pendingUpdates) {
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const [field, value] of Object.entries(updates)) {
        setClauses.push(`${field} = $${paramIndex++}`);
        values.push(value);
      }

      setClauses.push('updated_at = NOW()');
      values.push(id);

      await client.query(
        `UPDATE ens_names SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
        values,
      );
      updated++;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return updated;
}

// --- Checkpoint ---

function saveCheckpoint(checkpoint: Checkpoint) {
  const dir = path.dirname(CHECKPOINT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

function loadCheckpoint(): Checkpoint | null {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function clearCheckpoint() {
  try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE); } catch {}
}

// --- Results file ---

function appendResult(line: object) {
  const dir = path.dirname(RESULTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(line) + '\n');
}

// --- Main ---

async function main() {
  console.log('\n========================================');
  console.log('Validate ENS Data v2');
  console.log('========================================\n');

  // Parse args
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const fixTokenIds = args.includes('--fix-token-ids');
  const shouldResume = args.includes('--resume');

  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 0; // 0 = no limit

  const graphBatchIdx = args.indexOf('--graph-batch-size');
  const graphBatchSize = graphBatchIdx !== -1 ? parseInt(args[graphBatchIdx + 1]) : 50;

  const concurrencyIdx = args.indexOf('--graph-concurrency');
  const graphConcurrency = concurrencyIdx !== -1 ? parseInt(args[concurrencyIdx + 1]) : 3;

  const fromIdx = args.indexOf('--from');
  let startFromId = fromIdx !== -1 ? parseInt(args[fromIdx + 1]) : 0;
  let resumedProcessed = 0;

  if (shouldResume) {
    const checkpoint = loadCheckpoint();
    if (checkpoint) {
      startFromId = checkpoint.lastId;
      resumedProcessed = checkpoint.processed;
      console.log(`Resuming from checkpoint: id > ${startFromId} (${resumedProcessed.toLocaleString()} already done)\n`);
    } else {
      console.log('No checkpoint found, starting from beginning\n');
    }
  }

  console.log(`Dry run:           ${dryRun ? 'YES' : 'NO'}`);
  console.log(`Limit:             ${limit || 'none'}`);
  console.log(`Graph batch size:  ${graphBatchSize}`);
  console.log(`Graph concurrency: ${graphConcurrency}`);
  console.log(`Fix token IDs:     ${fixTokenIds ? 'YES' : 'NO'}`);
  console.log(`Verbose:           ${verbose ? 'YES' : 'NO'}\n`);

  const pool = getPostgresPool();
  currentLastId = startFromId;
  currentProcessed = resumedProcessed;
  const startTime = Date.now();

  const stats: Stats = {
    processed: 0,
    valid: 0,
    invalid: 0,
    updated: 0,
    notFound: 0,
    errors: 0,
    fieldMismatches: {
      owner_address: 0,
      registrant: 0,
      expiry_date: 0,
      registration_date: 0,
      token_id: 0,
    },
  };

  // Clear results file on fresh start
  if (!shouldResume) {
    try { if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE); } catch {}
  }

  // Graceful shutdown
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\nShutting down gracefully...');
    saveCheckpoint({ lastId: currentLastId, processed: currentProcessed, startedAt: new Date(startTime).toISOString() });
    console.log(`Checkpoint saved (last_id: ${currentLastId}, processed: ${currentProcessed.toLocaleString()})`);
    console.log('Run with --resume to continue.\n');
    await closeAllConnections();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Get total qualifying records
    const countResult = await pool.query(`
      SELECT COUNT(*) as total FROM ens_names
      WHERE name NOT LIKE '#%'
        AND name NOT LIKE 'token-%'
        AND name NOT LIKE '%.%.eth'
        AND name NOT LIKE '[%].eth'
        AND name LIKE '%.eth'
        AND id > $1
    `, [startFromId]);
    let totalToProcess = parseInt(countResult.rows[0].total);
    if (limit > 0) totalToProcess = Math.min(totalToProcess, limit);

    console.log(`Records to validate: ${totalToProcess.toLocaleString()}\n`);

    let dbBatchCount = 0;
    let pendingUpdates: PendingUpdate[] = [];
    let limitRemaining = limit || Infinity;

    while (!shuttingDown && limitRemaining > 0) {
      const fetchSize = Math.min(DB_BATCH_SIZE, limitRemaining);

      // Keyset pagination
      const result = await pool.query(`
        SELECT id, name, token_id, owner_address, registrant, expiry_date, registration_date
        FROM ens_names
        WHERE id > $1
          AND name NOT LIKE '#%'
          AND name NOT LIKE 'token-%'
          AND name NOT LIKE '%.%.eth'
          AND name NOT LIKE '[%].eth'
          AND name LIKE '%.eth'
        ORDER BY id ASC
        LIMIT $2
      `, [currentLastId, fetchSize]);

      if (result.rows.length === 0) break;

      const records: EnsNameRecord[] = result.rows;

      // Query The Graph with concurrency
      const graphData = await queryGraphConcurrent(records, graphBatchSize, graphConcurrency);

      // Validate each record
      for (const record of records) {
        stats.processed++;
        const domain = graphData.get(record.name.toLowerCase());

        if (!domain) {
          stats.notFound++;
          if (verbose) console.log(`  -- ${record.name} - Not found in Graph`);
          continue;
        }

        const result = validateRecord(record, domain, fixTokenIds);

        if (result) {
          stats.invalid++;

          // Track field mismatches
          for (const mismatch of result.mismatches) {
            const field = mismatch.split(':')[0];
            if (field in stats.fieldMismatches) {
              stats.fieldMismatches[field]++;
            }
          }

          console.log(`  X ${record.name}`);
          for (const m of result.mismatches) console.log(`    ${m}`);

          // Stream to results file
          appendResult({ id: record.id, name: record.name, mismatches: result.mismatches });

          // Queue update
          if (!dryRun && Object.keys(result.updates).length > 0) {
            pendingUpdates.push({ id: record.id, updates: result.updates });
          }
        } else {
          stats.valid++;
          if (verbose) console.log(`  OK ${record.name}`);
        }
      }

      // Flush pending updates in batches
      if (pendingUpdates.length >= UPDATE_BATCH_SIZE) {
        try {
          const count = await flushUpdates(pool, pendingUpdates);
          stats.updated += count;
        } catch (error: any) {
          console.error(`  Update batch failed: ${error.message}`);
          stats.errors += pendingUpdates.length;
        }
        pendingUpdates = [];
      }

      // Update position
      currentLastId = records[records.length - 1].id;
      currentProcessed += records.length;
      dbBatchCount++;
      limitRemaining -= records.length;

      // Progress with ETA
      const elapsed = (Date.now() - startTime) / 1000;
      const processedThisRun = currentProcessed - resumedProcessed;
      const rate = processedThisRun / elapsed;
      const remaining = totalToProcess - processedThisRun;
      const etaSeconds = rate > 0 ? remaining / rate : 0;
      const etaMin = Math.floor(etaSeconds / 60);
      const etaSec = Math.floor(etaSeconds % 60);
      const pct = totalToProcess > 0 ? ((processedThisRun / totalToProcess) * 100).toFixed(1) : '0.0';

      console.log(
        `\n[${pct}%] ${currentProcessed.toLocaleString()} validated | ` +
        `${stats.invalid} mismatches | ` +
        `${Math.round(rate)} rec/s | ` +
        `ETA ${etaMin}m${etaSec}s\n`
      );

      // Periodic checkpoint
      if (dbBatchCount % CHECKPOINT_INTERVAL === 0) {
        saveCheckpoint({ lastId: currentLastId, processed: currentProcessed, startedAt: new Date(startTime).toISOString() });
      }
    }

    if (shuttingDown) return;

    // Flush remaining updates
    if (pendingUpdates.length > 0) {
      try {
        const count = await flushUpdates(pool, pendingUpdates);
        stats.updated += count;
      } catch (error: any) {
        console.error(`  Final update batch failed: ${error.message}`);
        stats.errors += pendingUpdates.length;
      }
    }

    clearCheckpoint();

    // Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const total = stats.processed;

    console.log('\n' + '='.repeat(50));
    console.log('Validation Summary');
    console.log('='.repeat(50));
    console.log(`Total processed:    ${total.toLocaleString()}`);
    console.log(`Valid:              ${stats.valid.toLocaleString()} (${total ? ((stats.valid / total) * 100).toFixed(1) : 0}%)`);
    console.log(`Mismatches:         ${stats.invalid.toLocaleString()} (${total ? ((stats.invalid / total) * 100).toFixed(1) : 0}%)`);
    console.log(`Not found in Graph: ${stats.notFound.toLocaleString()}`);
    console.log(`Update errors:      ${stats.errors.toLocaleString()}`);
    if (!dryRun) {
      console.log(`Updated:            ${stats.updated.toLocaleString()}`);
    }
    console.log(`Time elapsed:       ${duration}s`);

    console.log('\nMismatches by field:');
    for (const [field, count] of Object.entries(stats.fieldMismatches)) {
      if (field === 'token_id' && !fixTokenIds) continue;
      console.log(`  ${field.padEnd(20)} ${count.toLocaleString()}`);
    }

    if (dryRun) {
      console.log('\nDRY RUN - No changes were made');
    }

    if (stats.invalid > 0) {
      console.log(`\nDetailed mismatches written to: ${RESULTS_FILE}`);
    }

    console.log('');
    await closeAllConnections();
    process.exit(0);
  } catch (error: any) {
    saveCheckpoint({ lastId: currentLastId, processed: currentProcessed, startedAt: new Date(startTime).toISOString() });
    console.error('\nValidation failed:', error.message);
    console.error(`Checkpoint saved. Run with --resume to continue.\n`);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
