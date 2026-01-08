/**
 * Fix ENS Name Normalization Issues
 *
 * Single pass through all records:
 * 1. Normalize the name
 * 2. If invalid → delete the record
 * 3. If needs normalization:
 *    - If normalized name already exists → delete this record (it's illegitimate)
 *    - If no conflict → update the name to normalized form
 *
 * Note: FK constraints use ON DELETE CASCADE, so deleting an ens_name record
 * will automatically delete associated listings, offers, sales, watchlist entries.
 *
 * Usage:
 *   npx ts-node src/scripts/fix-ens-normalization.ts [--dry-run] [--verbose]
 */

import { getPostgresPool, normalizeEnsName } from '../../../shared/src';

const BATCH_SIZE = 1000;
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

interface FixStats {
  processed: number;
  skipped: number;
  normalized: number;
  deletedInvalid: number;
  deletedConflict: number;
  errors: number;
}

const stats: FixStats = {
  processed: 0,
  skipped: 0,
  normalized: 0,
  deletedInvalid: 0,
  deletedConflict: 0,
  errors: 0,
};

async function main() {
  const pool = getPostgresPool();

  console.log('=== Fix ENS Name Normalization ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Verbose: ${VERBOSE}\n`);

  // Get total count
  const countResult = await pool.query(`
    SELECT COUNT(*) FROM ens_names
    WHERE name !~ '^(token-[0-9]+|#[0-9]+|\\[[0-9a-fA-F]{64}\\]\\.eth)$'
  `);
  const totalCount = parseInt(countResult.rows[0].count);
  console.log(`Records to process: ${totalCount}\n`);

  let offset = 0;

  while (offset < totalCount) {
    const result = await pool.query(`
      SELECT id, name
      FROM ens_names
      WHERE name !~ '^(token-[0-9]+|#[0-9]+|\\[[0-9a-fA-F]{64}\\]\\.eth)$'
      ORDER BY id
      LIMIT $1 OFFSET $2
    `, [BATCH_SIZE, offset]);

    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      const { id, name } = row;
      stats.processed++;

      const normResult = normalizeEnsName(name);

      // Case 1: Invalid name → delete
      if (!normResult.isValid) {
        if (VERBOSE) {
          console.log(`[DELETE-INVALID] id=${id} "${name}" - ${normResult.error}`);
        }
        if (!DRY_RUN) {
          await pool.query('DELETE FROM ens_names WHERE id = $1', [id]);
        }
        stats.deletedInvalid++;
        continue;
      }

      // Case 2: Already normalized → skip
      if (normResult.wasAlreadyNormalized) {
        stats.skipped++;
        continue;
      }

      // Case 3: Needs normalization - check for conflict
      const normalized = normResult.normalized!;
      const conflictCheck = await pool.query(
        'SELECT id FROM ens_names WHERE name = $1 AND id != $2',
        [normalized, id]
      );

      if (conflictCheck.rows.length > 0) {
        // Conflict exists → delete this illegitimate record
        if (VERBOSE) {
          console.log(`[DELETE-CONFLICT] id=${id} "${name}" → "${normalized}" (exists as id=${conflictCheck.rows[0].id})`);
        }
        if (!DRY_RUN) {
          await pool.query('DELETE FROM ens_names WHERE id = $1', [id]);
        }
        stats.deletedConflict++;
      } else {
        // No conflict → update the name
        if (VERBOSE) {
          console.log(`[NORMALIZE] id=${id} "${name}" → "${normalized}"`);
        }
        if (!DRY_RUN) {
          await pool.query(
            'UPDATE ens_names SET name = $1, updated_at = NOW() WHERE id = $2',
            [normalized, id]
          );
        }
        stats.normalized++;
      }
    }

    offset += result.rows.length;
    console.log(`Progress: ${stats.processed}/${totalCount} | Normalized: ${stats.normalized} | Invalid: ${stats.deletedInvalid} | Conflicts: ${stats.deletedConflict}`);
  }

  console.log('\n=== Summary ===');
  console.log(`Processed: ${stats.processed}`);
  console.log(`Already normalized (skipped): ${stats.skipped}`);
  console.log(`Names normalized: ${stats.normalized}`);
  console.log(`Deleted (invalid): ${stats.deletedInvalid}`);
  console.log(`Deleted (conflict): ${stats.deletedConflict}`);
  console.log(`Errors: ${stats.errors}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes were made. Run without --dry-run to apply fixes.');
  }

  await pool.end();
}

main()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fix script failed:', error);
    process.exit(1);
  });
