/**
 * Diagnostic script to check renewal processing
 */

import { config, getPostgresPool } from '../../../shared/src';

async function main() {
  const pool = getPostgresPool();

  console.log('=== Renewal Diagnostic ===\n');

  // 1. Check last processed block
  const indexerState = await pool.query(`
    SELECT contract_address, last_processed_block, updated_at, last_processed_timestamp
    FROM indexer_state
    ORDER BY last_processed_block DESC
  `);
  console.log('Indexer State:');
  for (const row of indexerState.rows) {
    const updatedAgo = row.updated_at ? Math.round((Date.now() - new Date(row.updated_at).getTime()) / 1000) : 'unknown';
    console.log(`  ${row.contract_address}:`);
    console.log(`    last_processed_block: ${row.last_processed_block}`);
    console.log(`    updated_at: ${row.updated_at?.toISOString()} (${updatedAgo}s ago)`);
  }
  console.log(`  Target block: 24358602\n`);

  // 2. Check ref.eth and kol.eth
  const names = await pool.query(`
    SELECT name, token_id, expiry_date, owner_address, updated_at
    FROM ens_names
    WHERE name IN ('ref.eth', 'kol.eth')
  `);
  console.log('Name Status:');
  for (const row of names.rows) {
    const now = new Date();
    const isExpired = row.expiry_date < now;
    const graceEnd = new Date(row.expiry_date.getTime() + 90 * 24 * 60 * 60 * 1000);
    const isGracePeriod = isExpired && now < graceEnd;
    console.log(`  ${row.name}:`);
    console.log(`    token_id: ${row.token_id}`);
    console.log(`    expiry_date: ${row.expiry_date?.toISOString()}`);
    console.log(`    updated_at: ${row.updated_at?.toISOString()}`);
    console.log(`    is_expired: ${isExpired}, is_grace_period: ${isGracePeriod}`);
  }
  console.log();

  // 3. Check how far behind we are
  const lastBlock = indexerState.rows[0]?.last_processed_block || 0;
  const targetBlock = 24358602;
  const blocksBehind = targetBlock - lastBlock;
  const hoursBehind = (blocksBehind * 12) / 3600; // ~12 sec per block
  console.log(`Gap Analysis:`);
  console.log(`  Blocks behind: ${blocksBehind}`);
  console.log(`  Estimated time behind: ${hoursBehind.toFixed(1)} hours`);
  console.log();

  // 4. Check renewal transactions for these specific names
  const renewals = await pool.query(`
    SELECT t.transaction_hash, t.block_number, t.timestamp, e.name
    FROM transactions t
    JOIN ens_names e ON e.id = t.ens_name_id
    WHERE t.transaction_type = 'renewal'
      AND e.name IN ('ref.eth', 'kol.eth')
    ORDER BY t.timestamp DESC
    LIMIT 5
  `);
  console.log('Recent renewals for ref.eth/kol.eth:');
  if (renewals.rows.length === 0) {
    console.log('  No renewal transactions recorded');
  } else {
    for (const row of renewals.rows) {
      console.log(`  ${row.name}: block ${row.block_number}, tx ${row.transaction_hash?.slice(0, 20)}...`);
    }
  }
  console.log();

  // 5. Check recent renewal transactions globally to see if indexer is processing any
  const recentRenewals = await pool.query(`
    SELECT t.block_number, t.timestamp, e.name
    FROM transactions t
    JOIN ens_names e ON e.id = t.ens_name_id
    WHERE t.transaction_type = 'renewal'
    ORDER BY t.block_number DESC
    LIMIT 10
  `);
  console.log('Most recent renewals processed (any name):');
  if (recentRenewals.rows.length === 0) {
    console.log('  No renewal transactions recorded at all');
  } else {
    for (const row of recentRenewals.rows) {
      console.log(`  block ${row.block_number}: ${row.name} @ ${row.timestamp?.toISOString()}`);
    }
  }
  console.log();

  // 6. Check recent ens_names updates
  const recentUpdates = await pool.query(`
    SELECT name, expiry_date, updated_at
    FROM ens_names
    ORDER BY updated_at DESC
    LIMIT 10
  `);
  console.log('Most recently updated ens_names:');
  for (const row of recentUpdates.rows) {
    console.log(`  ${row.name}: expiry=${row.expiry_date?.toISOString()?.slice(0,10)}, updated=${row.updated_at?.toISOString()}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
