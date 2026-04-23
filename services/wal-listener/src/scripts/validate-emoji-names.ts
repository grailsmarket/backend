/**
 * Validate and Fix Emoji/Unicode ENS Names
 *
 * Targeted script for names affected by migration 0830 (emoji uniqueness fix).
 * Finds non-ASCII ENS names (emoji, unicode) and validates their data against
 * The Graph, fixing mismatches for: owner_address, registrant, token_id,
 * expiry_date, and registration_date.
 *
 * Scoping options:
 *   --zero-owner      Only check names with owner = zero address (the known symptom)
 *   --since DATETIME  Only check names updated since this timestamp (e.g., '2026-04-09 18:00')
 *   --name NAME       Check a single specific name
 *
 * Usage:
 *   npm run build && node dist/wal-listener/src/scripts/validate-emoji-names.js [options]
 *
 * Options:
 *   --dry-run          Don't update database, just report
 *   --zero-owner       Only names owned by zero address
 *   --since DATETIME   Only names updated after this time
 *   --name NAME        Validate a single name
 *   --fix-token-ids    Also fix token IDs (default: yes for this script)
 *   --limit N          Max records to process (default: all)
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const GRACE_PERIOD_SECONDS = 90 * 24 * 60 * 60;

const GRAPH_BATCH_SIZE = 50;
const GRAPH_CONCURRENCY = 3;
const DB_BATCH_SIZE = 500;
const UPDATE_BATCH_SIZE = 50;
const MAX_GRAPH_RETRIES = 3;
const GRAPH_RETRY_DELAY_MS = 1000;

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
  name: string;
  updates: Record<string, any>;
  mismatches: string[];
}

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

// --- Graph API ---

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

async function queryGraphConcurrent(
  records: EnsNameRecord[],
): Promise<Map<string, GraphDomainData>> {
  const combined = new Map<string, GraphDomainData>();

  const batches: string[][] = [];
  for (let i = 0; i < records.length; i += GRAPH_BATCH_SIZE) {
    batches.push(records.slice(i, i + GRAPH_BATCH_SIZE).map(r => r.name));
  }

  for (let i = 0; i < batches.length; i += GRAPH_CONCURRENCY) {
    const chunk = batches.slice(i, i + GRAPH_CONCURRENCY);
    const results = await Promise.all(chunk.map(names => queryGraphBatch(names)));

    for (const resultMap of results) {
      for (const [key, value] of resultMap) {
        combined.set(key, value);
      }
    }

    if (i + GRAPH_CONCURRENCY < batches.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return combined;
}

// --- Validation ---

function validateRecord(
  record: EnsNameRecord,
  graphData: GraphDomainData,
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

  // token_id
  if (graphData.labelhash) {
    const correctTokenId = getCorrectTokenId(graphData);
    if (record.token_id !== correctTokenId) {
      mismatches.push(`token_id: ${record.token_id.substring(0, 20)}... -> ${correctTokenId.substring(0, 20)}...`);
      updates.token_id = correctTokenId;
    }
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

// --- Main ---

async function main() {
  console.log('\n========================================');
  console.log('Validate Emoji/Unicode ENS Names');
  console.log('========================================\n');

  // Parse args
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const zeroOwnerOnly = args.includes('--zero-owner');

  const sinceIdx = args.indexOf('--since');
  const sinceDate = sinceIdx !== -1 ? args[sinceIdx + 1] : null;

  const nameIdx = args.indexOf('--name');
  const nameFilter = nameIdx !== -1 ? args[nameIdx + 1] : null;

  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 0;

  console.log(`Mode:         ${dryRun ? 'DRY RUN' : 'LIVE (will update database)'}`);
  if (nameFilter) console.log(`Name filter:  ${nameFilter}`);
  if (zeroOwnerOnly) console.log(`Scope:        Zero-address owners only`);
  if (sinceDate) console.log(`Since:        ${sinceDate}`);
  if (limit) console.log(`Limit:        ${limit}`);
  console.log('');

  const pool = getPostgresPool();

  // Build query to find affected names
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (nameFilter) {
    conditions.push(`name = $${paramIdx++}`);
    params.push(nameFilter);
  } else {
    // Non-ASCII names (emoji/unicode) that weren't covered by the old index
    // These are names that DON'T match the old ASCII-only regex
    conditions.push(`name NOT LIKE 'token-%'`);
    conditions.push(`name NOT LIKE '#%'`);
    conditions.push(`name NOT LIKE '[%].eth'`);
    conditions.push(`name LIKE '%.eth'`);
    conditions.push(`name NOT LIKE '%.%.eth'`);
    conditions.push(`name !~ '^[a-z0-9-]+\\.eth$'`);
  }

  if (zeroOwnerOnly) {
    conditions.push(`owner_address = $${paramIdx++}`);
    params.push(ZERO_ADDRESS);
  }

  if (sinceDate) {
    conditions.push(`updated_at >= $${paramIdx++}`);
    params.push(sinceDate);
  }

  const whereClause = conditions.join(' AND ');

  // Count
  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM ens_names WHERE ${whereClause}`,
    params,
  );
  let total = parseInt(countResult.rows[0].total);
  if (limit > 0) total = Math.min(total, limit);

  console.log(`Found ${total} names to validate\n`);

  if (total === 0) {
    console.log('Nothing to do!');
    await closeAllConnections();
    return;
  }

  // Process in batches with keyset pagination
  let lastId = 0;
  let processed = 0;
  let valid = 0;
  let invalid = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  let pendingUpdates: PendingUpdate[] = [];
  const startTime = Date.now();

  while (processed < total) {
    const fetchSize = Math.min(DB_BATCH_SIZE, total - processed);

    const batchResult = await pool.query(
      `SELECT id, name, token_id, owner_address, registrant, expiry_date, registration_date
       FROM ens_names
       WHERE ${whereClause} AND id > $${paramIdx}
       ORDER BY id ASC
       LIMIT $${paramIdx + 1}`,
      [...params, lastId, fetchSize],
    );

    if (batchResult.rows.length === 0) break;

    const records: EnsNameRecord[] = batchResult.rows;

    // Query The Graph
    const graphData = await queryGraphConcurrent(records);

    for (const record of records) {
      const domain = graphData.get(record.name.toLowerCase());

      if (!domain) {
        notFound++;
        console.log(`  -- ${record.name} (id:${record.id}) - Not found in Graph`);
        processed++;
        continue;
      }

      const result = validateRecord(record, domain);

      if (result) {
        invalid++;
        console.log(`  X  ${record.name} (id:${record.id})`);
        for (const m of result.mismatches) console.log(`     ${m}`);

        if (!dryRun && Object.keys(result.updates).length > 0) {
          pendingUpdates.push({ id: record.id, name: record.name, updates: result.updates, mismatches: result.mismatches });
        }
      } else {
        valid++;
      }

      processed++;
    }

    // Flush pending updates
    if (pendingUpdates.length >= UPDATE_BATCH_SIZE) {
      try {
        const count = await flushUpdates(pool, pendingUpdates);
        updated += count;
        console.log(`  -> Updated ${count} records`);
      } catch (error: any) {
        console.error(`  Update batch failed: ${error.message}`);
        errors += pendingUpdates.length;
      }
      pendingUpdates = [];
    }

    lastId = records[records.length - 1].id;

    // Progress
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const remaining = total - processed;
    const etaSeconds = rate > 0 ? remaining / rate : 0;
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0';
    console.log(
      `\n[${pct}%] ${processed}/${total} | ${invalid} mismatches | ${Math.round(rate)} rec/s | ETA ${Math.ceil(etaSeconds)}s\n`,
    );
  }

  // Flush remaining
  if (pendingUpdates.length > 0) {
    try {
      const count = await flushUpdates(pool, pendingUpdates);
      updated += count;
      console.log(`  -> Updated ${count} records`);
    } catch (error: any) {
      console.error(`  Final update batch failed: ${error.message}`);
      errors += pendingUpdates.length;
    }
  }

  // Summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(50));
  console.log('Validation Summary');
  console.log('='.repeat(50));
  console.log(`Total processed:    ${processed}`);
  console.log(`Valid:              ${valid}`);
  console.log(`Mismatches found:   ${invalid}`);
  console.log(`Not found in Graph: ${notFound}`);
  console.log(`Errors:             ${errors}`);
  if (!dryRun) {
    console.log(`Updated:            ${updated}`);
  } else {
    console.log(`\nDRY RUN - No changes were made`);
  }
  console.log(`Time elapsed:       ${duration}s\n`);

  await closeAllConnections();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
