#!/usr/bin/env tsx

/**
 * Fix Clubs Sync - Resynchronize ens_names.clubs from club_memberships
 *
 * This script fixes the denormalized clubs column on ens_names by re-aggregating
 * from the club_memberships source of truth table.
 *
 * Use this when:
 * - Names were reassociated/updated directly in ens_names
 * - The sync trigger didn't fire for some reason
 * - You suspect clubs data is out of sync
 *
 * Usage:
 *   npx tsx src/scripts/fix-clubs-sync.ts [options]
 *
 * Options:
 *   --dry-run       Don't update database, just report discrepancies
 *   --verbose       Show all records, not just mismatches
 *   --limit N       Limit to N club memberships (default: all)
 */

import { getPostgresPool } from '../../../shared/src';

interface ClubMembership {
  club_name: string;
  ens_name: string;
}

interface EnsNameClubs {
  id: number;
  name: string;
  clubs: string[] | null;
}

interface Discrepancy {
  name: string;
  expected: string[];
  actual: string[];
  ensNameId: number | null;
}

async function fixClubsSync(options: {
  dryRun?: boolean;
  verbose?: boolean;
  limit?: number;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun ?? false;
  const verbose = options.verbose ?? false;
  const limit = options.limit;

  try {
    console.log('\n=== Fix Clubs Sync ===\n');
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Verbose: ${verbose ? 'YES' : 'NO'}`);
    if (limit) console.log(`Limit: ${limit}`);
    console.log('');

    // Step 1: Get all club memberships grouped by ens_name
    console.log('Fetching club memberships...');
    const membershipQuery = `
      SELECT
        LOWER(ens_name) as ens_name,
        array_agg(club_name ORDER BY club_name) as expected_clubs
      FROM club_memberships
      GROUP BY LOWER(ens_name)
      ${limit ? `LIMIT ${limit}` : ''}
    `;
    const membershipResult = await pool.query(membershipQuery);
    const expectedClubsByName = new Map<string, string[]>();
    for (const row of membershipResult.rows) {
      expectedClubsByName.set(row.ens_name.toLowerCase(), row.expected_clubs);
    }
    console.log(`Found ${expectedClubsByName.size} unique names in club_memberships\n`);

    // Step 2: Get all ens_names that are in clubs or should be
    console.log('Fetching ens_names records...');
    const namesArray = Array.from(expectedClubsByName.keys());

    // Query in batches to avoid parameter limits
    const batchSize = 5000;
    const ensNamesByLowerName = new Map<string, EnsNameClubs>();

    for (let i = 0; i < namesArray.length; i += batchSize) {
      const batch = namesArray.slice(i, i + batchSize);
      const ensQuery = `
        SELECT id, name, clubs
        FROM ens_names
        WHERE LOWER(name) = ANY($1)
      `;
      const ensResult = await pool.query(ensQuery, [batch]);
      for (const row of ensResult.rows) {
        ensNamesByLowerName.set(row.name.toLowerCase(), {
          id: row.id,
          name: row.name,
          clubs: row.clubs,
        });
      }
    }
    console.log(`Found ${ensNamesByLowerName.size} matching ens_names records\n`);

    // Step 3: Find discrepancies
    const discrepancies: Discrepancy[] = [];
    const notFoundInEnsNames: string[] = [];
    let validCount = 0;

    for (const [lowerName, expectedClubs] of expectedClubsByName.entries()) {
      const ensRecord = ensNamesByLowerName.get(lowerName);

      if (!ensRecord) {
        notFoundInEnsNames.push(lowerName);
        continue;
      }

      const actualClubs = (ensRecord.clubs || []).sort();
      const sortedExpected = [...expectedClubs].sort();

      // Compare arrays
      const isMatch =
        actualClubs.length === sortedExpected.length &&
        actualClubs.every((club, idx) => club === sortedExpected[idx]);

      if (isMatch) {
        validCount++;
        if (verbose) {
          console.log(`  ✅ ${ensRecord.name}: [${actualClubs.join(', ')}]`);
        }
      } else {
        discrepancies.push({
          name: ensRecord.name,
          expected: sortedExpected,
          actual: actualClubs,
          ensNameId: ensRecord.id,
        });
      }
    }

    // Step 4: Also check for ens_names with clubs that shouldn't have them
    console.log('Checking for orphaned clubs in ens_names...');
    const orphanQuery = `
      SELECT id, name, clubs
      FROM ens_names
      WHERE clubs IS NOT NULL
        AND array_length(clubs, 1) > 0
        AND LOWER(name) NOT IN (
          SELECT DISTINCT LOWER(ens_name) FROM club_memberships
        )
    `;
    const orphanResult = await pool.query(orphanQuery);
    const orphanedClubs: Discrepancy[] = orphanResult.rows.map(row => ({
      name: row.name,
      expected: [],
      actual: row.clubs || [],
      ensNameId: row.id,
    }));
    console.log(`Found ${orphanedClubs.length} names with orphaned clubs\n`);

    // Combine all discrepancies
    const allDiscrepancies = [...discrepancies, ...orphanedClubs];

    // Step 5: Report findings
    console.log('=' .repeat(60));
    console.log('=== Sync Status Report ===');
    console.log('='.repeat(60) + '\n');

    console.log(`Total club memberships checked: ${expectedClubsByName.size}`);
    console.log(`Valid (in sync):               ${validCount}`);
    console.log(`Discrepancies found:           ${discrepancies.length}`);
    console.log(`Not found in ens_names:        ${notFoundInEnsNames.length}`);
    console.log(`Orphaned clubs (no membership): ${orphanedClubs.length}`);
    console.log('');

    if (notFoundInEnsNames.length > 0 && notFoundInEnsNames.length <= 20) {
      console.log('Names not found in ens_names:');
      notFoundInEnsNames.forEach(name => console.log(`  - ${name}`));
      console.log('');
    } else if (notFoundInEnsNames.length > 20) {
      console.log(`Names not found in ens_names (showing first 20 of ${notFoundInEnsNames.length}):`);
      notFoundInEnsNames.slice(0, 20).forEach(name => console.log(`  - ${name}`));
      console.log('');
    }

    if (allDiscrepancies.length > 0) {
      console.log('Discrepancies:');
      const showCount = Math.min(allDiscrepancies.length, 50);
      for (let i = 0; i < showCount; i++) {
        const d = allDiscrepancies[i];
        console.log(`  ❌ ${d.name}`);
        console.log(`     Expected: [${d.expected.join(', ') || 'none'}]`);
        console.log(`     Actual:   [${d.actual.join(', ') || 'none'}]`);
      }
      if (allDiscrepancies.length > 50) {
        console.log(`  ... and ${allDiscrepancies.length - 50} more`);
      }
      console.log('');
    }

    // Step 6: Fix discrepancies if not dry run
    if (!dryRun && allDiscrepancies.length > 0) {
      console.log('Fixing discrepancies...\n');

      let fixed = 0;
      let errors = 0;

      for (const d of allDiscrepancies) {
        if (d.ensNameId === null) continue;

        try {
          const updateQuery = `
            UPDATE ens_names
            SET clubs = $1, updated_at = NOW()
            WHERE id = $2
          `;
          await pool.query(updateQuery, [
            d.expected.length > 0 ? d.expected : null,
            d.ensNameId,
          ]);
          fixed++;
        } catch (err: any) {
          console.error(`  Error fixing ${d.name}: ${err.message}`);
          errors++;
        }
      }

      console.log(`Fixed: ${fixed}`);
      console.log(`Errors: ${errors}`);
      console.log('\n✅ Database has been updated!');
      console.log('\n⚠️  Remember to resync Elasticsearch:');
      console.log('   npx tsx src/scripts/resync-elasticsearch.ts');
    } else if (dryRun && allDiscrepancies.length > 0) {
      console.log('⚠️  DRY RUN - No changes were made to the database');
      console.log('Run without --dry-run to apply fixes\n');
    } else {
      console.log('✅ All clubs are in sync! No fixes needed.\n');
    }

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
  verbose?: boolean;
  limit?: number;
} = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    options.dryRun = true;
  } else if (args[i] === '--verbose') {
    options.verbose = true;
  } else if (args[i] === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  }
}

// Main execution
fixClubsSync(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
