#!/usr/bin/env tsx
/**
 * Import club rankings from CSV into club_memberships.rank
 *
 * Usage:
 *   npx tsx src/scripts/import-club-rankings.ts
 *
 * Reads data/prepunk_rankings.csv (columns: rank_number, name)
 * and updates the rank column on matching club_memberships rows
 * where club_name starts with 'prepunk'.
 *
 * Rows with blank names are skipped. Original rank numbers are preserved.
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import * as fs from 'fs';
import * as path from 'path';

const BATCH_SIZE = 500;
const CSV_PATH = path.join(__dirname, '../../../../data/prepunk_rankings_digits_only.csv');

interface RankEntry {
  rank: number;
  name: string;
}

function parseCSV(filePath: string): RankEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const entries: RankEntry[] = [];

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse quoted CSV: "rank_number","name" or "rank_number",
    const match = line.match(/^"(\d+)","?([^"]*)"?$/);
    if (!match) continue;

    const rank = parseInt(match[1], 10);
    const name = match[2].trim();

    // Skip blank names
    if (!name) continue;

    entries.push({ rank, name: `${name}.eth` });
  }

  return entries;
}

async function main() {
  const pool = getPostgresPool();

  console.log(`Reading CSV from ${CSV_PATH}...`);
  const entries = parseCSV(CSV_PATH);
  const totalInCSV = 506; // known total data rows
  const skipped = totalInCSV - entries.length;

  console.log(`Parsed ${entries.length} entries (${skipped} blank names skipped)`);
  console.log(`Updating ranks in batches of ${BATCH_SIZE}...\n`);

  let rowsUpdated = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    // Build a batch UPDATE using a VALUES list
    const values: (string | number)[] = [];
    const valueClauses: string[] = [];

    for (let j = 0; j < batch.length; j++) {
      const paramBase = j * 2;
      valueClauses.push(`($${paramBase + 1}::integer, $${paramBase + 2}::text)`);
      values.push(batch[j].rank, batch[j].name);
    }

    const result = await pool.query(
      `UPDATE club_memberships cm
       SET rank = v.rank
       FROM (VALUES ${valueClauses.join(',')}) AS v(rank, name)
       WHERE cm.ens_name = v.name
         AND cm.club_name = 'prepunk_digits'`,
      values
    );

    rowsUpdated += result.rowCount || 0;

    const progress = Math.min(i + BATCH_SIZE, entries.length);
    process.stdout.write(`\r  Processed ${progress}/${entries.length} (${rowsUpdated} membership rows updated)`);
  }

  // Count distinct names that actually got ranked
  const countResult = await pool.query(
    `SELECT COUNT(DISTINCT ens_name) as cnt FROM club_memberships WHERE club_name = 'prepunk_digits' AND rank IS NOT NULL`
  );
  const namesRanked = parseInt(countResult.rows[0].cnt) || 0;

  console.log('\n\nSummary:');
  console.log(`  Total CSV rows: ${totalInCSV}`);
  console.log(`  Skipped (blank name): ${skipped}`);
  console.log(`  Membership rows updated: ${rowsUpdated}`);
  console.log(`  Distinct names ranked: ${namesRanked}`);
  console.log(`  Names not found in prepunk digits club: ${entries.length - namesRanked}`);

  await closeAllConnections();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Error:', err);
  await closeAllConnections();
  process.exit(1);
});
