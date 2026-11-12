import fs from 'fs';
import path from 'path';
import {
  replaceAnniversaryClaims,
  validateAnniversaryProofs,
  type AnniversaryProofs,
} from '../src/services/anniversary-nft';

/**
 * Import Grails anniversary NFT claim proofs from the merkle generator's proofs.json
 *
 * Validates the whole file before touching the database (merkleRoot / leafEncoding format,
 * every address and its lowercase key, token ids unique and in 1..total, special iff
 * tokenId <= counts.special, counts, proof hex, and every proof against merkleRoot), then
 * replaces the contents of anniversary_nft_claims in ONE transaction, so a re-import after a
 * list change leaves no stale rows.
 *
 * Usage:
 *   npm run import:anniversary:dry-run path/to/proofs.json     # validate + summary, no DB access
 *   npm run import:anniversary path/to/proofs.json             # validate + replace the table
 *
 * --dry-run never loads the database layer. `npm run import:anniversary <file> --dry-run`
 * (without `--`) is also treated as a dry run: npm keeps that flag for itself and only exposes
 * it as npm_config_dry_run.
 */

const MAX_ERRORS_SHOWN = 25;

function printSummary(proofs: AnniversaryProofs) {
  const { merkleRoot, counts, claims } = proofs;
  const lengths = claims.map((c) => c.proof.length);
  const range = (from: number, to: number) => (to >= from ? `ids ${from}–${to}` : 'none');

  console.log(`   Merkle root: ${merkleRoot}`);
  console.log(`   Special:     ${counts.special} (${range(1, counts.special)})`);
  console.log(`   Generic:     ${counts.generic} (${range(counts.special + 1, counts.total)})`);
  console.log(`   Total:       ${counts.total}`);
  console.log(`   Proof size:  ${Math.min(...lengths)}–${Math.max(...lengths)} hashes`);
}

/** "host:port/db" from a connection string, without credentials. */
function describeDatabase(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function replaceClaims(proofs: AnniversaryProofs) {
  // Loaded here, not at the top, so a dry run never reads DB config or creates a pool.
  const { getPostgresPool, closeAllConnections, config } = await import('../../shared/src');

  console.log(`Writing to database: ${describeDatabase(config.database.url)}`);

  const pool = getPostgresPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const { deleted } = await replaceAnniversaryClaims(client, proofs, {
      onProgress: (inserted) => process.stdout.write(`\r   Inserted: ${inserted}/${proofs.claims.length}`),
    });
    process.stdout.write('\n');
    console.log(`   Removed ${deleted} previous rows`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Transaction rolled back');
    throw error;
  } finally {
    client.release();
    await closeAllConnections();
  }
}

async function importAnniversaryProofs(filePath: string, dryRun: boolean) {
  console.log(`\n=== Anniversary NFT Proofs Import${dryRun ? ' (DRY RUN)' : ''} ===`);
  console.log(`Reading from: ${filePath}\n`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found at ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error: any) {
    throw new Error(`Could not parse JSON: ${error.message}`);
  }

  const started = Date.now();
  const result = validateAnniversaryProofs(parsed);
  if (!result.ok) {
    console.error(`❌ Validation failed with ${result.errors.length} error(s):`);
    for (const error of result.errors.slice(0, MAX_ERRORS_SHOWN)) {
      console.error(`   - ${error}`);
    }
    if (result.errors.length > MAX_ERRORS_SHOWN) {
      console.error(`   ... and ${result.errors.length - MAX_ERRORS_SHOWN} more`);
    }
    throw new Error('Validation failed; database not touched');
  }

  const { proofs } = result;
  console.log(`✅ Validated ${proofs.claims.length} claims, all proofs verify against the root (${Date.now() - started}ms)\n`);

  if (dryRun) {
    console.log('🔍 DRY RUN - database not touched\n');
  } else {
    await replaceClaims(proofs);
    console.log(`\n✅ Replaced anniversary_nft_claims\n`);
  }

  console.log('📊 Summary:');
  printSummary(proofs);
  console.log('');
}

// Main execution
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || process.env.npm_config_dry_run === 'true';
const unknownFlags = args.filter((a) => a.startsWith('-') && a !== '--dry-run');
const files = args.filter((a) => !a.startsWith('-'));

if (files.length !== 1 || unknownFlags.length > 0) {
  console.error('❌ Usage: npm run import:anniversary <path-to-proofs.json>');
  console.error('   Dry run (validate only, no DB): npm run import:anniversary:dry-run <path-to-proofs.json>');
  process.exit(1);
}

// npm runs scripts from services/api; INIT_CWD is where npm was invoked.
const absolutePath = path.resolve(process.env.INIT_CWD || process.cwd(), files[0]);

importAnniversaryProofs(absolutePath, dryRun)
  .then(() => {
    console.log(dryRun ? '✅ Dry run completed successfully' : '✅ Import completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Import failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
