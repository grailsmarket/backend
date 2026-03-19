#!/usr/bin/env tsx
/**
 * Import club rankings for 2019_short_name_auction_1k from CSV into club_memberships.rank
 *
 * Usage:
 *   npm run import-rankings-short-name-auction
 *
 * Reads data/short_name_auction_ranks_1k.csv (columns: name.eth,rank — no header)
 * and updates the rank column on matching club_memberships rows
 * where club_name = '2019_short_name_auction_1k'.
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import * as fs from 'fs';
import * as path from 'path';

const BATCH_SIZE = 500;
const CSV_PATH = path.join(__dirname, '../../../../data/short_name_auction_ranks_1k.csv');

interface RankEntry {
  rank: number;
  name: string;
}

function parseCSV(filePath: string): RankEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const entries: RankEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Format: name.eth,rank (no header, no quotes)
    const commaIdx = line.lastIndexOf(',');
    if (commaIdx === -1) continue;

    const name = line.substring(0, commaIdx).trim();
    const rank = parseInt(line.substring(commaIdx + 1).trim(), 10);

    if (!name || isNaN(rank)) continue;

    // Names already include .eth suffix
    entries.push({ rank, name });
  }

  return entries;
}

async function main() {
  const pool = getPostgresPool();

  console.log(`Reading CSV from ${CSV_PATH}...`);
  const entries = parseCSV(CSV_PATH);

  console.log(`Parsed ${entries.length} entries`);
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
         AND cm.club_name = '2019_short_name_auction_1k'`,
      values
    );

    rowsUpdated += result.rowCount || 0;

    const progress = Math.min(i + BATCH_SIZE, entries.length);
    process.stdout.write(`\r  Processed ${progress}/${entries.length} (${rowsUpdated} membership rows updated)`);
  }

  // Count distinct names that actually got ranked
  const countResult = await pool.query(
    `SELECT COUNT(DISTINCT ens_name) as cnt FROM club_memberships WHERE club_name = '2019_short_name_auction_1k' AND rank IS NOT NULL`
  );
  const namesRanked = parseInt(countResult.rows[0].cnt) || 0;

  console.log('\n\nSummary:');
  console.log(`  Parsed from CSV: ${entries.length}`);
  console.log(`  Membership rows updated: ${rowsUpdated}`);
  console.log(`  Distinct names ranked: ${namesRanked}`);
  console.log(`  Names not found in club: ${entries.length - namesRanked}`);

  await closeAllConnections();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Error:', err);
  await closeAllConnections();
  process.exit(1);
});
