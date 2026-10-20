/**
 * Import compromised (stolen) names from a CSV export of the incident spreadsheet
 * (e.g. the "Affected names" sheet of names_me_exploit.xlsx).
 *
 * Expected columns (header row): name, token_id, "original_owner (stolen from)", taken_by,
 * taken_at_utc, tx_hash, block. Rows whose name is "(name unknown, see token_id)" are matched to
 * ens_names by token_id.
 *
 * Dry run by default — prints what would be written. Pass --apply to write.
 *
 * Usage:
 *   npm run import-compromised -- <csv-file> [--apply] [--incident=magic-eden-ppv2-2026-09]
 */

import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { getPostgresPool, closeAllConnections, safeNormalize } from '../../../shared/src';

// Known incidents. The operator is the contract victims had approved (setApprovalForAll) on the
// ENS registrar / NameWrapper and that was used to move the names.
const INCIDENTS: Record<string, {
  title: string;
  description: string;
  infoUrl: string | null;
  maliciousOperators: string[];
  occurredAt: string;
}> = {
  'magic-eden-ppv2-2026-09': {
    title: 'Magic Eden exploit (September 2026)',
    description:
      'This name was taken from its owner in the September 2026 Magic Eden exploit, which abused ' +
      'wallet approvals granted to the Limit Break Payment Processor V2 contract. Only the original ' +
      'owner can buy it back or have their offer accepted on Grails.',
    infoUrl: null,
    // Limit Break Payment Processor V2
    maliciousOperators: ['0x9a1d00bed7cd04bcda516d721a596eb22aac6834'],
    occurredAt: '2026-09-25T11:16:00Z',
  },
};

const UNKNOWN_NAME = '(name unknown, see token_id)';
const ADDRESS_RE = /^0x[a-f0-9]{40}$/;

interface SheetRow {
  name: string;
  token_id: string;
  'original_owner (stolen from)': string;
  taken_by: string;
  taken_at_utc: string;
  tx_hash: string;
  block: string;
}

interface ImportRow {
  ensNameId: number | null;
  name: string;
  tokenId: string | null;
  originalOwner: string;
  takenBy: string | null;
  takenTxHash: string | null;
  takenBlock: number | null;
  takenAt: Date | null;
  currentOwner: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const apply = args.includes('--apply');
  const incident = args.find((a) => a.startsWith('--incident='))?.split('=')[1] || 'magic-eden-ppv2-2026-09';
  if (!file) {
    console.error('Usage: import-compromised-names <csv-file> [--apply] [--incident=<slug>]');
    process.exit(1);
  }
  if (!INCIDENTS[incident]) {
    console.error(`Unknown incident "${incident}". Known: ${Object.keys(INCIDENTS).join(', ')}`);
    process.exit(1);
  }
  return { file, apply, incident };
}

function lowerAddress(value: string | undefined): string | null {
  const v = (value || '').trim().toLowerCase();
  return ADDRESS_RE.test(v) ? v : null;
}

async function main() {
  const { file, apply, incident } = parseArgs();
  const pool = getPostgresPool();

  const sheet: SheetRow[] = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  console.log(`Read ${sheet.length} rows from ${file}`);

  const rows: ImportRow[] = [];
  const problems: string[] = [];

  for (const r of sheet) {
    const originalOwner = lowerAddress(r['original_owner (stolen from)']);
    if (!originalOwner) {
      problems.push(`${r.name || r.token_id}: missing/invalid original_owner`);
      continue;
    }

    const tokenId = /^\d+$/.test(r.token_id || '') ? r.token_id : null;
    const sheetName = r.name && r.name !== UNKNOWN_NAME ? safeNormalize(r.name) : null;

    // Match by normalized name first (token_id may be a labelhash or a NameWrapper namehash),
    // then fall back to token_id.
    let match = sheetName
      ? await pool.query(`SELECT id, name, owner_address FROM ens_names WHERE LOWER(name) = $1`, [sheetName])
      : null;
    if ((!match || match.rows.length === 0) && tokenId) {
      match = await pool.query(`SELECT id, name, owner_address FROM ens_names WHERE token_id = $1`, [tokenId]);
    }
    const en = match?.rows[0];
    const name = sheetName || en?.name;

    if (!name) {
      problems.push(`token ${tokenId}: unknown name and no ens_names row for token_id`);
      continue;
    }

    const block = parseFloat(r.block);
    rows.push({
      ensNameId: en?.id ?? null,
      name,
      tokenId,
      originalOwner,
      takenBy: lowerAddress(r.taken_by),
      takenTxHash: /^0x[a-fA-F0-9]{64}$/.test(r.tx_hash || '') ? r.tx_hash.toLowerCase() : null,
      takenBlock: Number.isFinite(block) ? Math.round(block) : null,
      takenAt: r.taken_at_utc ? new Date(`${r.taken_at_utc.replace(' ', 'T')}:00Z`) : null,
      currentOwner: en?.owner_address?.toLowerCase() ?? null,
    });
  }

  const unmatched = rows.filter((r) => r.ensNameId === null);
  const alreadyBack = rows.filter((r) => r.currentOwner === r.originalOwner);
  const dupes = rows.length - new Set(rows.map((r) => r.name)).size;

  console.log(`\nPrepared ${rows.length} names`);
  console.log(`  matched to ens_names:      ${rows.length - unmatched.length}`);
  console.log(`  not in ens_names (kept, ens_name_id NULL): ${unmatched.length}`);
  console.log(`  already back with original owner (will auto-resolve): ${alreadyBack.length}`);
  if (dupes) console.log(`  duplicate names in sheet (last row wins): ${dupes}`);
  if (unmatched.length) console.log(`  e.g. ${unmatched.slice(0, 10).map((r) => r.name).join(', ')}`);
  if (alreadyBack.length) console.log(`  back: ${alreadyBack.map((r) => r.name).join(', ')}`);
  if (problems.length) {
    console.log(`\nSkipped ${problems.length} rows:`);
    problems.forEach((p) => console.log(`  - ${p}`));
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to import.');
    await closeAllConnections();
    return;
  }

  const meta = INCIDENTS[incident];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inc = await client.query(
      `INSERT INTO compromise_incidents (slug, title, description, info_url, malicious_operators, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         info_url = EXCLUDED.info_url,
         malicious_operators = EXCLUDED.malicious_operators,
         occurred_at = EXCLUDED.occurred_at,
         updated_at = NOW()
       RETURNING id`,
      [incident, meta.title, meta.description, meta.infoUrl, meta.maliciousOperators, meta.occurredAt]
    );
    const incidentId = inc.rows[0].id;

    // Re-runnable: refreshes source fields, keeps admin edits (allowed_addresses, status, notes).
    let written = 0;
    for (const r of rows) {
      await client.query(
        `INSERT INTO compromised_names (
           incident_id, ens_name_id, name, token_id, original_owner,
           taken_by, taken_tx_hash, taken_block, taken_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (name) DO UPDATE SET
           incident_id = EXCLUDED.incident_id,
           ens_name_id = COALESCE(EXCLUDED.ens_name_id, compromised_names.ens_name_id),
           token_id = EXCLUDED.token_id,
           original_owner = EXCLUDED.original_owner,
           taken_by = EXCLUDED.taken_by,
           taken_tx_hash = EXCLUDED.taken_tx_hash,
           taken_block = EXCLUDED.taken_block,
           taken_at = EXCLUDED.taken_at,
           updated_at = NOW()`,
        [incidentId, r.ensNameId, r.name, r.tokenId, r.originalOwner, r.takenBy, r.takenTxHash, r.takenBlock, r.takenAt]
      );
      written++;
    }
    await client.query('COMMIT');
    console.log(`\nImported ${written} names under incident "${incident}" (id ${incidentId}).`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await closeAllConnections();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
