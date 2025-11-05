#!/usr/bin/env tsx
/**
 * Migration Runner Script
 *
 * Runs all SQL migration files in the migrations/seq directory in order.
 * Creates a migrations_log table to track which migrations have been applied.
 *
 * Usage:
 *   tsx scripts/run-migrations.ts
 *
 * Options:
 *   --dry-run: Show which migrations would run without executing them
 *   --force: Re-run all migrations (drops migrations_log table)
 */

import { getPostgresPool, closeAllConnections } from '../../shared/src';
import * as fs from 'fs';
import * as path from 'path';

const pool = getPostgresPool();

interface MigrationFile {
  filename: string;
  filepath: string;
  sequence: number;
}

/**
 * Create migrations tracking table if it doesn't exist
 */
async function createMigrationsTable(): Promise<void> {
  const query = `
    CREATE TABLE IF NOT EXISTS migrations_log (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `;

  await pool.query(query);
  console.log('✓ Migrations log table ready\n');
}

/**
 * Get list of already applied migrations
 */
async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await pool.query(
    'SELECT filename FROM migrations_log ORDER BY applied_at'
  );

  return new Set(result.rows.map(row => row.filename));
}

/**
 * Get all migration files from the seq directory, sorted by sequence number
 */
function getMigrationFiles(): MigrationFile[] {
  const migrationsDir = path.join(__dirname, '../migrations/seq');

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .map(filename => {
      // Extract sequence number from filename (e.g., 0010_fix_duplicate.sql -> 10)
      const match = filename.match(/^(\d+)_/);
      const sequence = match ? parseInt(match[1], 10) : 0;

      return {
        filename,
        filepath: path.join(migrationsDir, filename),
        sequence
      };
    })
    .sort((a, b) => a.sequence - b.sequence);

  return files;
}

/**
 * Run a single migration file
 */
async function runMigration(migration: MigrationFile, dryRun: boolean): Promise<void> {
  const sql = fs.readFileSync(migration.filepath, 'utf-8');

  console.log(`Running: ${migration.filename}`);

  if (dryRun) {
    console.log('  [DRY RUN - skipped]');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Execute the migration SQL
    await client.query(sql);

    // Record that this migration was applied
    await client.query(
      'INSERT INTO migrations_log (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      [migration.filename]
    );

    await client.query('COMMIT');
    console.log(`  ✓ Success\n`);
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error(`  ✗ Failed: ${error.message}\n`);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Main migration runner
 */
async function runMigrations() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  console.log('=== Database Migration Runner ===\n');

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  if (force) {
    console.log('⚠️  FORCE MODE - Re-running all migrations\n');
    if (!dryRun) {
      await pool.query('DROP TABLE IF EXISTS migrations_log');
      console.log('Dropped migrations_log table\n');
    }
  }

  try {
    // Create migrations tracking table
    if (!dryRun) {
      await createMigrationsTable();
    }

    // Get all migration files
    const migrations = getMigrationFiles();
    console.log(`Found ${migrations.length} migration files\n`);

    // Get already applied migrations
    const appliedMigrations = dryRun ? new Set() : await getAppliedMigrations();

    if (appliedMigrations.size > 0 && !force) {
      console.log(`${appliedMigrations.size} migrations already applied\n`);
    }

    // Filter out already applied migrations (unless force mode)
    const pendingMigrations = force
      ? migrations
      : migrations.filter(m => !appliedMigrations.has(m.filename));

    if (pendingMigrations.length === 0) {
      console.log('✓ All migrations are up to date!\n');
      return;
    }

    console.log(`Running ${pendingMigrations.length} pending migrations:\n`);

    // Run each pending migration in order
    for (const migration of pendingMigrations) {
      await runMigration(migration, dryRun);
    }

    console.log('=== Migration Complete ===\n');
    console.log(`✓ Successfully applied ${pendingMigrations.length} migrations`);

  } catch (error: any) {
    console.error('\n=== Migration Failed ===\n');
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    await closeAllConnections();
  }
}

// Run migrations
runMigrations();
