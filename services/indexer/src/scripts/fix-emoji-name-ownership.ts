/**
 * Fix emoji / keycap ENS names with incorrect stored name, token_id, or ownership.
 *
 * Background
 * ----------
 * ENSIP-15 normalization (viem `normalize`) strips the U+FE0F variation selector from
 * keycap emoji, so the canonical on-chain form of e.g. "2️⃣7️⃣2️⃣.eth" is the *bare*
 * keycap "2⃣7⃣2⃣.eth" (digit + U+20E3, no FE0F). The chain hashes the normalized label,
 * so on-chain Transfer / NameRegistered events carry the canonical labelhash/namehash.
 * If a row was stored under the display form (with FE0F), its `name` and `token_id` are
 * non-canonical: on-chain ownership updates (which match by the canonical token_id, or by
 * exact `name`) never land on it, so ownership goes stale / wrong.
 *
 * What this does
 * --------------
 * For every 2LD .eth name that looks like emoji/keycap, it:
 *   1. Normalizes the stored name per ENSIP-15 (canonical form).
 *   2. Computes the canonical labelhash and asks The Graph (via ENSResolver, the same
 *      logic the live indexer uses) for the correct token_id (namehash if wrapped &
 *      unexpired, else labelhash) and the true owner / registrant.
 *   3. Classifies the row (ok / name / token / owner mismatch / conflict).
 *   4. Corrects it:
 *        - No conflict  -> UPDATE name, token_id, owner_address, registrant in place.
 *        - Conflict     -> a *different* row already holds the canonical name or token_id.
 *                          Treat that canonical row as the keeper, re-point every child
 *                          row (FK on ens_names.id, discovered dynamically) from the stale
 *                          row to the keeper -- skipping any that would violate the child's
 *                          own unique constraints -- then delete the stale row. Children are
 *                          NEVER cascade-deleted blindly.
 *
 * Safety
 * ------
 * DRY RUN by default. It only writes when run with `--apply`. Conflict merges run inside a
 * single transaction per stale row so they are atomic.
 *
 * Usage (per project rule: tsx OOMs here, build first):
 *   npm run build && node dist/indexer/src/scripts/fix-emoji-name-ownership.js            # dry run
 *   npm run build && node dist/indexer/src/scripts/fix-emoji-name-ownership.js --apply    # write
 *   ... --verbose   # log every row, not just changes
 *   ... --name=2⃣7⃣2⃣.eth   # restrict to one stored name (repeatable)
 */

import { labelhash } from 'viem/ens';
import type { Pool, PoolClient } from 'pg';
import { config, getPostgresPool, safeNormalize, isPlaceholderName } from '../../../shared/src';
import { ENSResolver } from '../services/ens-resolver';
import { logger } from '../utils/logger';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const NAME_FILTERS = process.argv
  .filter(a => a.startsWith('--name='))
  .map(a => a.slice('--name='.length));

// Literal U+FE0F (variation selector-16) and U+20E3 (combining enclosing keycap).
const FE0F = '️';
const KEYCAP = '⃣';

interface NameRow {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
  registrant: string | null;
}

interface FkChild {
  table: string;
  column: string;
}

type Classification =
  | 'ok'
  | 'invalid'           // can't normalize
  | 'unresolved'        // The Graph returned nothing
  | 'name-mismatch'
  | 'token-mismatch'
  | 'owner-mismatch'
  | 'conflict';

interface Stats {
  scanned: number;
  ok: number;
  invalid: number;
  unresolved: number;
  fixedInPlace: number;
  merged: number;
  childrenRepointed: number;
  childrenSkipped: number;
  errors: number;
}

const stats: Stats = {
  scanned: 0,
  ok: 0,
  invalid: 0,
  unresolved: 0,
  fixedInPlace: 0,
  merged: 0,
  childrenRepointed: 0,
  childrenSkipped: 0,
  errors: 0,
};

const VALID_IDENT = /^[a-z_][a-z0-9_]*$/;
function quoteIdent(ident: string): string {
  if (!VALID_IDENT.test(ident)) {
    throw new Error(`Refusing to use unsafe SQL identifier: ${JSON.stringify(ident)}`);
  }
  return `"${ident}"`;
}

/**
 * Discover every table.column that is a FOREIGN KEY onto ens_names(id).
 * Done at runtime so we never miss a child table that exists in the live DB but not in
 * the checked-in schema.sql (registrations, activity_history, sales, watchlist, ...).
 */
async function discoverFkChildren(pool: Pool): Promise<FkChild[]> {
  const result = await pool.query<{ child_table: string; child_column: string }>(`
    SELECT
      tc.table_name  AS child_table,
      kcu.column_name AS child_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema   = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema   = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name  = 'ens_names'
      AND ccu.column_name = 'id'
    ORDER BY tc.table_name, kcu.column_name
  `);
  return result.rows.map(r => ({ table: r.child_table, column: r.child_column }));
}

/** Canonical labelhash (decimal) of a normalized 2LD label, or null if not a single-label .eth. */
function canonicalLabelhashDecimal(normalizedName: string): string | null {
  if (!normalizedName.endsWith('.eth')) return null;
  const label = normalizedName.slice(0, -'.eth'.length);
  if (!label || label.includes('.')) return null; // subnames out of scope
  return BigInt(labelhash(label)).toString(10);
}

/**
 * Re-point all FK children from `staleId` to `keeperId`, skipping rows that would collide
 * with the keeper's existing rows on a unique constraint. Runs inside the caller's tx.
 */
async function repointChildren(
  client: PoolClient,
  children: FkChild[],
  staleId: number,
  keeperId: number,
): Promise<{ repointed: number; skipped: Array<{ table: string; column: string }> }> {
  let repointed = 0;
  const skipped: Array<{ table: string; column: string }> = [];

  for (const { table, column } of children) {
    const t = quoteIdent(table);
    const c = quoteIdent(column);

    // Fast path: move the whole table at once inside a savepoint.
    await client.query('SAVEPOINT repoint_tbl');
    try {
      const res = await client.query(
        `UPDATE ${t} SET ${c} = $1 WHERE ${c} = $2`,
        [keeperId, staleId],
      );
      await client.query('RELEASE SAVEPOINT repoint_tbl');
      repointed += res.rowCount ?? 0;
    } catch (err: any) {
      if (err.code !== '23505') throw err; // not a unique violation -> real error
      // Collision: fall back to row-by-row, skipping the colliding rows.
      await client.query('ROLLBACK TO SAVEPOINT repoint_tbl');
      await client.query('RELEASE SAVEPOINT repoint_tbl');

      const rows = await client.query(
        `SELECT ctid FROM ${t} WHERE ${c} = $1`,
        [staleId],
      );
      for (const row of rows.rows) {
        await client.query('SAVEPOINT repoint_row');
        try {
          await client.query(
            `UPDATE ${t} SET ${c} = $1 WHERE ctid = $2`,
            [keeperId, row.ctid],
          );
          await client.query('RELEASE SAVEPOINT repoint_row');
          repointed += 1;
        } catch (rowErr: any) {
          if (rowErr.code !== '23505') throw rowErr;
          await client.query('ROLLBACK TO SAVEPOINT repoint_row');
          await client.query('RELEASE SAVEPOINT repoint_row');
          // Leave on the stale row; it is dropped when the stale ens_names row is deleted.
          skipped.push({ table, column });
          console.log(`        - skip ${table}.${column} ctid=${row.ctid} (would duplicate a keeper row)`);
        }
      }
    }
  }

  return { repointed, skipped };
}

async function main() {
  const pool = getPostgresPool();
  const resolver = new ENSResolver();

  console.log('='.repeat(70));
  console.log('Fix Emoji / Keycap ENS Name Ownership');
  console.log('='.repeat(70));
  console.log(`Mode:        ${APPLY ? 'APPLY (will write to the database)' : 'DRY RUN (no changes)'}`);
  console.log(`Subgraph:    ${config.theGraph?.ensSubgraphUrl}`);
  if (NAME_FILTERS.length) console.log(`Name filter: ${NAME_FILTERS.join(', ')}`);
  console.log('='.repeat(70));
  console.log();

  const children = await discoverFkChildren(pool);
  console.log(`Discovered ${children.length} FK child column(s) on ens_names(id):`);
  console.log('  ' + children.map(c => `${c.table}.${c.column}`).join(', '));
  console.log();

  // Candidate rows: 2LD .eth (single label), non-placeholder, that look emoji/keycap.
  // has_emoji covers keycaps (hasEmoji() matches U+20E3); the FE0F/keycap LIKEs are belt
  // and suspenders for any row mis-flagged before has_emoji existed.
  const params: any[] = [FE0F, KEYCAP];
  let nameClause = '';
  if (NAME_FILTERS.length) {
    nameClause = ` AND name = ANY($3)`;
    params.push(NAME_FILTERS);
  }
  const candidates = await pool.query<NameRow>(
    `SELECT id, name, token_id, owner_address, registrant
       FROM ens_names
      WHERE name LIKE '%.eth'
        AND name NOT LIKE '%.%.%'
        AND name !~ '^(token-[0-9]+|#[0-9]+|\\[[0-9a-fA-F]{64}\\]\\.eth)$'
        AND (has_emoji = true OR position($1 in name) > 0 OR position($2 in name) > 0)
        ${nameClause}
      ORDER BY id`,
    params,
  );

  console.log(`Found ${candidates.rows.length} candidate emoji/keycap name(s) to check\n`);

  for (const row of candidates.rows) {
    stats.scanned++;
    const { id, name, token_id, owner_address, registrant } = row;

    if (isPlaceholderName(name)) {
      stats.ok++;
      continue;
    }

    // 1. Canonical name + labelhash.
    const normalized = safeNormalize(name);
    const canonLabelhashDec = canonicalLabelhashDecimal(normalized);
    if (!canonLabelhashDec) {
      classify('invalid', row, `cannot derive canonical labelhash (subname or invalid)`);
      stats.invalid++;
      continue;
    }

    // 2. Ask The Graph (same resolver the live indexer uses) for the true token_id + owner.
    let resolved;
    try {
      resolved = await resolver.resolveTokenIdToNameData(canonLabelhashDec);
    } catch (err: any) {
      console.log(`  ERROR  ${name}: resolver threw: ${err?.message}`);
      stats.errors++;
      continue;
    }
    if (!resolved || !resolved.name) {
      classify('unresolved', row, `The Graph returned no domain for canonical labelhash`);
      stats.unresolved++;
      continue;
    }

    const correctName = resolved.name;                 // canonical name from The Graph
    const correctTokenId = resolved.correctTokenId;    // namehash if wrapped+unexpired, else labelhash
    const trueOwner = resolved.ownerAddress;           // already resolves wrapper -> wrappedOwner
    const trueRegistrant = resolved.registrantAddress;

    const nameWrong = name !== correctName;
    const tokenWrong = token_id !== correctTokenId;
    const ownerWrong = !!trueOwner && owner_address.toLowerCase() !== trueOwner.toLowerCase();

    if (!nameWrong && !tokenWrong && !ownerWrong) {
      if (VERBOSE) console.log(`  ok     ${name}`);
      stats.ok++;
      continue;
    }

    // 3. Is there a *different* row already holding the canonical name or token_id?
    const conflict = await pool.query<{ id: number; name: string; token_id: string }>(
      `SELECT id, name, token_id FROM ens_names
        WHERE (name = $1 OR token_id = $2) AND id != $3`,
      [correctName, correctTokenId, id],
    );

    if (conflict.rows.length === 0) {
      // ---- No conflict: fix this row in place. ----
      classify(nameWrong ? 'name-mismatch' : tokenWrong ? 'token-mismatch' : 'owner-mismatch', row, null);
      console.log(`         stored : name=${JSON.stringify(name)} token=${token_id} owner=${owner_address}`);
      console.log(`         canon  : name=${JSON.stringify(correctName)} token=${correctTokenId} owner=${trueOwner ?? '(unknown)'}`);

      if (APPLY) {
        try {
          await pool.query(
            `UPDATE ens_names
                SET name = $1,
                    token_id = $2,
                    owner_address = COALESCE($3, owner_address),
                    registrant = COALESCE($4, registrant),
                    updated_at = NOW()
              WHERE id = $5`,
            [correctName, correctTokenId, trueOwner, trueRegistrant, id],
          );
          console.log(`         => FIXED in place`);
          stats.fixedInPlace++;
        } catch (err: any) {
          console.log(`         => ERROR: ${err.message}`);
          stats.errors++;
        }
      } else {
        console.log(`         => would fix in place (dry run)`);
        stats.fixedInPlace++;
      }
    } else {
      // ---- Conflict: a canonical keeper row exists. Merge children, drop stale row. ----
      const keeper = conflict.rows[0];
      classify('conflict', row, `keeper id=${keeper.id} already holds canonical name/token`);
      console.log(`         stale  : id=${id} name=${JSON.stringify(name)} token=${token_id}`);
      console.log(`         keeper : id=${keeper.id} name=${JSON.stringify(keeper.name)} token=${keeper.token_id}`);

      if (APPLY) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // Make sure the keeper carries the correct token_id + true owner.
          await client.query(
            `UPDATE ens_names
                SET token_id = $1,
                    owner_address = COALESCE($2, owner_address),
                    registrant = COALESCE($3, registrant),
                    updated_at = NOW()
              WHERE id = $4`,
            [correctTokenId, trueOwner, trueRegistrant, keeper.id],
          );

          const { repointed, skipped } = await repointChildren(client, children, id, keeper.id);
          await client.query('DELETE FROM ens_names WHERE id = $1', [id]);

          await client.query('COMMIT');
          console.log(`         => MERGED into id=${keeper.id} (repointed ${repointed} child row(s), skipped ${skipped.length})`);
          stats.merged++;
          stats.childrenRepointed += repointed;
          stats.childrenSkipped += skipped.length;
        } catch (err: any) {
          await client.query('ROLLBACK');
          console.log(`         => ERROR (rolled back): ${err.message}`);
          stats.errors++;
        } finally {
          client.release();
        }
      } else {
        console.log(`         => would merge into id=${keeper.id}, re-point its children, then delete stale row (dry run)`);
        stats.merged++;
      }
    }

    // Be gentle with The Graph / RPC.
    await new Promise(r => setTimeout(r, 100));
  }

  console.log();
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`Scanned:              ${stats.scanned}`);
  console.log(`Already correct:      ${stats.ok}`);
  console.log(`Invalid (skipped):    ${stats.invalid}`);
  console.log(`Unresolved (skipped): ${stats.unresolved}`);
  console.log(`Fixed in place:       ${stats.fixedInPlace}`);
  console.log(`Merged (conflict):    ${stats.merged}`);
  console.log(`  child rows moved:   ${stats.childrenRepointed}`);
  console.log(`  child rows skipped: ${stats.childrenSkipped}`);
  console.log(`Errors:               ${stats.errors}`);
  if (!APPLY) {
    console.log();
    console.log('DRY RUN — nothing was written. Re-run with --apply to make changes.');
  }

  await pool.end();
}

function classify(kind: Classification, row: NameRow, detail: string | null) {
  const tag = kind.toUpperCase().padEnd(14);
  console.log(`  ${tag} ${row.name}${detail ? `  (${detail})` : ''}`);
}

main()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch(err => {
    logger.error('fix-emoji-name-ownership failed:', err);
    console.error(err);
    process.exit(1);
  });
