#!/usr/bin/env tsx
/**
 * Backfill has_numbers and has_emoji for existing ENS names
 *
 * Usage:
 *   npx tsx src/scripts/backfill-name-attributes.ts
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();

function calculateNameAttributes(name: string) {
  return {
    has_numbers: /\d/.test(name),
    has_emoji: /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(name),
  };
}

async function backfillNameAttributes() {
  console.log('Starting backfill of has_numbers and has_emoji fields...\n');

  try {
    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM ens_names WHERE has_numbers IS NULL OR has_emoji IS NULL'
    );
    const totalRows = parseInt(countResult.rows[0].total);

    if (totalRows === 0) {
      console.log('✓ All records already have has_numbers and has_emoji populated!');
      await closeAllConnections();
      process.exit(0);
    }

    console.log(`Found ${totalRows} records to update\n`);

    const batchSize = 1000;
    let processed = 0;

    while (processed < totalRows) {
      // Fetch batch of names that need updating
      const query = `
        SELECT id, name
        FROM ens_names
        WHERE has_numbers IS NULL OR has_emoji IS NULL
        ORDER BY id
        LIMIT $1
      `;

      const result = await pool.query(query, [batchSize]);

      if (result.rows.length === 0) {
        break; // No more rows to process
      }

      // Build batch update
      const updatePromises = result.rows.map(async (row) => {
        const { has_numbers, has_emoji } = calculateNameAttributes(row.name);

        await pool.query(
          'UPDATE ens_names SET has_numbers = $1, has_emoji = $2, updated_at = NOW() WHERE id = $3',
          [has_numbers, has_emoji, row.id]
        );
      });

      await Promise.all(updatePromises);

      processed += result.rows.length;
      const percentage = ((processed / totalRows) * 100).toFixed(1);
      console.log(`Progress: ${processed}/${totalRows} (${percentage}%)`);

      // Small delay to avoid overwhelming database
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n✓ Backfill complete! Updated ${processed} records.`);
    console.log('\n⚠️  Don\'t forget to resync Elasticsearch: npm run resync');

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Backfill failed:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

backfillNameAttributes();
