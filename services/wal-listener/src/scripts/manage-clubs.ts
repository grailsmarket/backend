#!/usr/bin/env tsx
/**
 * Club Management CLI (Junction Table Edition)
 *
 * Usage:
 *   npx tsx src/scripts/manage-clubs.ts add <club-name> <names-file> [--description "Club description"]
 *   npx tsx src/scripts/manage-clubs.ts add-pattern <club-name> <pattern> [--description "Club description"]
 *   npx tsx src/scripts/manage-clubs.ts remove <club-name> <names-file>
 *   npx tsx src/scripts/manage-clubs.ts list-clubs
 *   npx tsx src/scripts/manage-clubs.ts list-names <club-name>
 *   npx tsx src/scripts/manage-clubs.ts clear <club-name> --confirm
 *   npx tsx src/scripts/manage-clubs.ts delete-club <club-name> --confirm
 *
 * Examples:
 *   npx tsx src/scripts/manage-clubs.ts add brands data/clubs/brands.json --description "Brand names"
 *   npx tsx src/scripts/manage-clubs.ts add crypto-terms data/clubs/crypto.csv
 *   npx tsx src/scripts/manage-clubs.ts add-pattern 1k-club 3-digits --description "Three digit club (000-999)"
 *   npx tsx src/scripts/manage-clubs.ts add-pattern 10k-club 4-digits --description "Four digit club (0000-9999)"
 *   npx tsx src/scripts/manage-clubs.ts remove brands data/clubs/remove.txt
 *   npx tsx src/scripts/manage-clubs.ts list-clubs
 *   npx tsx src/scripts/manage-clubs.ts list-names brands
 *   npx tsx src/scripts/manage-clubs.ts clear brands --confirm
 *   npx tsx src/scripts/manage-clubs.ts delete-club old-club --confirm
 *
 * File formats supported:
 *   - JSON: ["name1.eth", "name2.eth"]
 *   - CSV: name1.eth\nname2.eth\n
 *   - TXT: name1.eth\nname2.eth\n (lines starting with # are ignored)
 *
 * Architecture:
 *   - club_memberships table is the source of truth
 *   - Triggers automatically sync to ens_names.clubs (denormalized)
 *   - WAL listener syncs to Elasticsearch automatically
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import * as fs from 'fs';
import * as path from 'path';

const pool = getPostgresPool();

function loadNamesFromFile(filePath: string): string[] {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');

  if (ext === '.json') {
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [data];
  } else if (ext === '.csv' || ext === '.txt') {
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // Filter empty lines and comments
  } else {
    throw new Error(`Unsupported file format: ${ext}. Use .json, .csv, or .txt`);
  }
}

function generateNamesFromPattern(pattern: string): string[] {
  switch (pattern) {
    case '3-digits':
    case '3-digit':
    case '1k':
      // Generate 000.eth through 999.eth
      const threeDigitNames: string[] = [];
      for (let i = 0; i <= 999; i++) {
        const paddedNumber = i.toString().padStart(3, '0');
        threeDigitNames.push(`${paddedNumber}.eth`);
      }
      return threeDigitNames;

    case '4-digits':
    case '4-digit':
    case '10k':
      // Generate 0000.eth through 9999.eth
      const fourDigitNames: string[] = [];
      for (let i = 0; i <= 9999; i++) {
        const paddedNumber = i.toString().padStart(4, '0');
        fourDigitNames.push(`${paddedNumber}.eth`);
      }
      return fourDigitNames;

    default:
      throw new Error(`Unknown pattern: ${pattern}. Supported patterns: 3-digits, 4-digits`);
  }
}

async function ensureClubExists(clubName: string, description?: string) {
  await pool.query(
    `INSERT INTO clubs (name, description)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE
     SET description = COALESCE($2, clubs.description)`,
    [clubName, description || null]
  );
}

async function addNamesToClub(clubName: string, names: string[], description?: string) {
  console.log(`Adding ${names.length} names to club "${clubName}"...`);

  // Ensure the club exists
  await ensureClubExists(clubName, description);

  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const name of names) {
    try {
      const result = await pool.query(
        `INSERT INTO club_memberships (club_name, ens_name)
         VALUES ($1, $2)
         ON CONFLICT (club_name, ens_name) DO NOTHING
         RETURNING club_name`,
        [clubName, name]
      );

      if (result.rowCount && result.rowCount > 0) {
        added++;
        console.log(`  ✓ ${name}`);
      } else {
        skipped++;
        console.log(`  ⊘ ${name} (already in club)`);
      }
    } catch (error: any) {
      errors.push(name);
      console.log(`  ✗ ${name} (error: ${error.message})`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Added: ${added}`);
  console.log(`  Skipped (already in club): ${skipped}`);
  if (errors.length > 0) {
    console.log(`  Errors: ${errors.length}`);
  }
  console.log(`  Total processed: ${names.length}`);
  console.log(`\n✓ Triggers have auto-synced to ens_names.clubs`);
  console.log(`⚠️  Don't forget to resync Elasticsearch: npx tsx src/scripts/resync-elasticsearch.ts`);
}

async function removeNamesFromClub(clubName: string, names: string[]) {
  console.log(`Removing ${names.length} names from club "${clubName}"...`);

  let removed = 0;
  let notInClub = 0;

  for (const name of names) {
    const result = await pool.query(
      `DELETE FROM club_memberships
       WHERE club_name = $1 AND LOWER(ens_name) = LOWER($2)
       RETURNING club_name`,
      [clubName, name]
    );

    if (result.rowCount && result.rowCount > 0) {
      removed++;
      console.log(`  ✓ ${name}`);
    } else {
      notInClub++;
      console.log(`  ⊘ ${name} (not in club)`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Removed: ${removed}`);
  console.log(`  Not in club: ${notInClub}`);
  console.log(`  Total processed: ${names.length}`);
  console.log(`\n✓ Triggers have auto-synced to ens_names.clubs`);
  console.log(`⚠️  Don't forget to resync Elasticsearch: npx tsx src/scripts/resync-elasticsearch.ts`);
}

async function listAllClubs() {
  const result = await pool.query(`
    SELECT
      name,
      description,
      member_count,
      created_at,
      updated_at
    FROM clubs
    ORDER BY member_count DESC, name
  `);

  if (result.rows.length === 0) {
    console.log('No clubs found.');
    return;
  }

  console.log('\nClubs:\n');
  console.log('Name'.padEnd(25) + 'Members'.padEnd(12) + 'Description');
  console.log('─'.repeat(70));

  for (const row of result.rows) {
    const name = row.name.padEnd(25);
    const count = row.member_count.toString().padEnd(12);
    const desc = row.description || '(no description)';
    console.log(`${name}${count}${desc}`);
  }

  const totalMembers = result.rows.reduce((sum, row) => sum + parseInt(row.member_count), 0);
  console.log(`\nTotal clubs: ${result.rows.length}`);
  console.log(`Total memberships: ${totalMembers}`);
}

async function listNamesInClub(clubName: string) {
  // First check if club exists
  const clubResult = await pool.query(
    'SELECT name, description, member_count FROM clubs WHERE name = $1',
    [clubName]
  );

  if (clubResult.rows.length === 0) {
    console.log(`Club "${clubName}" not found.`);
    return;
  }

  const club = clubResult.rows[0];

  // Get all names in club
  const result = await pool.query(
    `SELECT ens_name, added_at
     FROM club_memberships
     WHERE club_name = $1
     ORDER BY added_at DESC, ens_name`,
    [clubName]
  );

  console.log(`\nClub: ${club.name}`);
  if (club.description) {
    console.log(`Description: ${club.description}`);
  }
  console.log(`Total members: ${club.member_count}\n`);

  if (result.rows.length === 0) {
    console.log('No names in this club.');
    return;
  }

  console.log('Names:');
  for (const row of result.rows) {
    const date = new Date(row.added_at).toISOString().split('T')[0];
    console.log(`  ${row.ens_name} (added: ${date})`);
  }
}

async function clearClub(clubName: string) {
  // Check if club exists
  const clubResult = await pool.query(
    'SELECT member_count FROM clubs WHERE name = $1',
    [clubName]
  );

  if (clubResult.rows.length === 0) {
    console.log(`Club "${clubName}" not found.`);
    return;
  }

  const memberCount = clubResult.rows[0].member_count;

  if (!process.argv.includes('--confirm')) {
    console.log(`⚠️  This will remove ALL ${memberCount} names from club "${clubName}".`);
    console.log('The club metadata will remain, but all memberships will be deleted.');
    console.log('\nUse --confirm flag to proceed.');
    return;
  }

  const result = await pool.query(
    'DELETE FROM club_memberships WHERE club_name = $1 RETURNING ens_name',
    [clubName]
  );

  console.log(`✓ Removed ${result.rowCount} names from club "${clubName}".`);
  console.log(`✓ Triggers have auto-synced to ens_names.clubs`);
  console.log(`⚠️  Don't forget to resync Elasticsearch: npx tsx src/scripts/resync-elasticsearch.ts`);
}

async function deleteClub(clubName: string) {
  // Check if club exists
  const clubResult = await pool.query(
    'SELECT member_count FROM clubs WHERE name = $1',
    [clubName]
  );

  if (clubResult.rows.length === 0) {
    console.log(`Club "${clubName}" not found.`);
    return;
  }

  const memberCount = clubResult.rows[0].member_count;

  if (!process.argv.includes('--confirm')) {
    console.log(`⚠️  This will PERMANENTLY DELETE club "${clubName}" and remove it from ${memberCount} names.`);
    console.log('This action cannot be undone.');
    console.log('\nUse --confirm flag to proceed.');
    return;
  }

  // Delete will cascade to club_memberships due to foreign key
  const result = await pool.query(
    'DELETE FROM clubs WHERE name = $1 RETURNING name',
    [clubName]
  );

  console.log(`✓ Deleted club "${clubName}" and removed from ${memberCount} names.`);
  console.log(`✓ Triggers have auto-synced to ens_names.clubs`);
  console.log(`⚠️  Don't forget to resync Elasticsearch: npx tsx src/scripts/resync-elasticsearch.ts`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'add': {
        const clubName = args[1];
        const filePath = args[2];
        const descIndex = args.indexOf('--description');
        const description = descIndex !== -1 ? args[descIndex + 1] : undefined;

        if (!clubName || !filePath) {
          console.error('Usage: manage-clubs.ts add <club-name> <names-file> [--description "text"]');
          process.exit(1);
        }

        const names = loadNamesFromFile(filePath);
        await addNamesToClub(clubName, names, description);
        break;
      }

      case 'add-pattern': {
        const clubName = args[1];
        const pattern = args[2];
        const descIndex = args.indexOf('--description');
        const description = descIndex !== -1 ? args[descIndex + 1] : undefined;

        if (!clubName || !pattern) {
          console.error('Usage: manage-clubs.ts add-pattern <club-name> <pattern> [--description "text"]');
          console.error('\nSupported patterns:');
          console.error('  3-digits (or 3-digit, 1k)  - Generates 000.eth through 999.eth');
          console.error('  4-digits (or 4-digit, 10k) - Generates 0000.eth through 9999.eth');
          process.exit(1);
        }

        const names = generateNamesFromPattern(pattern);
        console.log(`Generated ${names.length} names from pattern "${pattern}"`);
        await addNamesToClub(clubName, names, description);
        break;
      }

      case 'remove': {
        const clubName = args[1];
        const filePath = args[2];

        if (!clubName || !filePath) {
          console.error('Usage: manage-clubs.ts remove <club-name> <names-file>');
          process.exit(1);
        }

        const names = loadNamesFromFile(filePath);
        await removeNamesFromClub(clubName, names);
        break;
      }

      case 'list-clubs': {
        await listAllClubs();
        break;
      }

      case 'list-names': {
        const clubName = args[1];

        if (!clubName) {
          console.error('Usage: manage-clubs.ts list-names <club-name>');
          process.exit(1);
        }

        await listNamesInClub(clubName);
        break;
      }

      case 'clear': {
        const clubName = args[1];

        if (!clubName) {
          console.error('Usage: manage-clubs.ts clear <club-name> --confirm');
          process.exit(1);
        }

        await clearClub(clubName);
        break;
      }

      case 'delete-club': {
        const clubName = args[1];

        if (!clubName) {
          console.error('Usage: manage-clubs.ts delete-club <club-name> --confirm');
          process.exit(1);
        }

        await deleteClub(clubName);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log('\nAvailable commands:');
        console.log('  add <club-name> <names-file> [--description "text"]');
        console.log('  add-pattern <club-name> <pattern> [--description "text"]');
        console.log('  remove <club-name> <names-file>');
        console.log('  list-clubs');
        console.log('  list-names <club-name>');
        console.log('  clear <club-name> --confirm');
        console.log('  delete-club <club-name> --confirm');
        console.log('\nPatterns for add-pattern:');
        console.log('  3-digits, 3-digit, 1k   - 000.eth through 999.eth');
        console.log('  4-digits, 4-digit, 10k  - 0000.eth through 9999.eth');
        process.exit(1);
    }

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
