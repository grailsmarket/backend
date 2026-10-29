#!/usr/bin/env node

/**
 * Repair owners reverted by a script that read from the frozen Railway ENSNode
 *
 * The Railway prod ENSNode (ensnode-api-production-500f) stopped indexing at block 26158937
 * (2026-10-10 ~01:27 UTC) but kept answering with stale data. A validate/fix script run against
 * it after 2026-10-24 reverted owner_address + registrant on v1 names whose ownership changed
 * after the freeze (e.g. saif.eth, jogger.eth, 8⃣7⃣.eth went back to their previous owners).
 *
 * What it does:
 *   1. Loads v1 .eth names with on-chain activity (transactions, registrations, sales) after
 *      --from-block.
 *   2. Reads the current owner on chain (BaseRegistrar, plus NameWrapper for wrapped names).
 *   3. For rows whose DB owner differs from chain, fetches the frozen Railway ENSNode's owner.
 *      Only rows whose DB owner EQUALS that stale value are repaired (that's the fingerprint of
 *      this incident). Other mismatches are reported but left alone, unless --any-mismatch.
 *   4. Sets owner_address = effective owner and registrant = BaseRegistrar owner (NameWrapper for
 *      wrapped names, same as the indexer stores them). Each UPDATE is guarded: it only applies
 *      if the row still holds the value we read, so concurrent indexer writes win.
 *
 * ENSv2 names (ens_version = 2) are not touched.
 *
 * Usage:
 *   npm run repair-stale-ensnode-owners:dry
 *   npm run repair-stale-ensnode-owners -- --apply
 *
 * Options:
 *   --apply            Write changes (default: dry run)
 *   --from-block N     Only names with activity after this block (default: 26158937)
 *   --from-time ISO    Same cut-off for rows stored without a block number, e.g. app-reported
 *                      sales (default: 2026-10-10T02:07:23Z, the timestamp of that block)
 *   --names a.eth,b    Only these names (skips the activity scan)
 *   --any-mismatch     Also fix chain mismatches that don't match the stale ENSNode value
 *   --stale-url URL    The frozen ENSNode (default: Railway prod)
 *   --out PATH         Plan/results JSON (default: data/repair-stale-ensnode-owners-<ts>.json)
 *
 * Note: the root .env points at the prod database. The target host is printed at start-up.
 */

import { config, viemChain, getPostgresPool, closeAllConnections, safeNormalize } from '../../../shared/src';
import { createPublicClient, http, keccak256, namehash, parseAbi, toBytes } from 'viem';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_STALE_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const DEFAULT_FROM_BLOCK = 26158937; // last block the Railway ENSNode indexed
const DEFAULT_FROM_TIME = '2026-10-10T02:07:23Z'; // that block's timestamp
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MULTICALL_CHUNK = 300;
const GRAPH_BATCH = 50;
const GRAPH_RETRIES = 4;

const ownerOfAbi = parseAbi(['function ownerOf(uint256) view returns (address)']);

// --- Args ---

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes('--apply');
const ANY_MISMATCH = process.argv.includes('--any-mismatch');
const FROM_BLOCK = parseInt(argValue('--from-block') || String(DEFAULT_FROM_BLOCK), 10);
// Rows without a block number are matched by time
const FROM_TIME = new Date(argValue('--from-time') || DEFAULT_FROM_TIME);
const STALE_URL = argValue('--stale-url') || DEFAULT_STALE_URL;
const NAMES = argValue('--names')?.split(',').map(n => safeNormalize(n.trim())).filter(Boolean);
const OUT = argValue('--out')
  || path.join(process.cwd(), 'data', `repair-stale-ensnode-owners-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const NAME_WRAPPER = config.blockchain.ensNameWrapperAddress.toLowerCase();
const BASE_REGISTRAR = config.blockchain.ensRegistrarAddress as `0x${string}`;

// --- Types ---

interface Candidate {
  id: number;
  name: string;
  owner_address: string | null;
  registrant: string | null;
}

interface ChainOwner {
  baseOwner: string | null; // BaseRegistrar ownerOf (NameWrapper if wrapped)
  owner: string | null;     // effective owner
  wrapped: boolean;
}

interface PlanRow {
  id: number;
  name: string;
  dbOwner: string | null;
  dbRegistrant: string | null;
  staleOwner: string | null;
  newOwner: string;
  newRegistrant: string;
  wrapped: boolean;
}

// --- Data loading ---

async function loadCandidates(): Promise<Candidate[]> {
  const pool = getPostgresPool();
  if (NAMES?.length) {
    const r = await pool.query(
      `SELECT id, name, owner_address, registrant FROM ens_names
       WHERE name = ANY($1) AND COALESCE(ens_version, 1) = 1`,
      [NAMES]
    );
    return r.rows;
  }
  const r = await pool.query(
    `SELECT en.id, en.name, en.owner_address, en.registrant
     FROM ens_names en
     WHERE COALESCE(en.ens_version, 1) = 1
       AND en.name ~ '^[^.]+\\.eth$'
       AND (
         en.id IN (SELECT ens_name_id FROM transactions WHERE block_number > $1)
         OR en.id IN (SELECT ens_name_id FROM registrations WHERE block_number > $1)
         OR en.id IN (SELECT ens_name_id FROM sales WHERE block_number > $1)
         -- Sales reported by the app (POST /fills) are stored with block_number 0, and the
         -- indexer's own transactions row for the same tx is then dropped as a duplicate,
         -- so match those rows by time instead
         OR en.id IN (SELECT ens_name_id FROM transactions
                      WHERE COALESCE(block_number, 0) = 0 AND timestamp > $2)
         OR en.id IN (SELECT ens_name_id FROM sales
                      WHERE COALESCE(block_number, 0) = 0 AND sale_date > $2)
       )
     ORDER BY en.id`,
    [FROM_BLOCK, FROM_TIME]
  );
  return r.rows;
}

async function readChainOwners(rows: Candidate[]): Promise<Map<number, ChainOwner>> {
  const client = createPublicClient({ chain: viemChain, transport: http(config.blockchain.rpcUrl) });
  const out = new Map<number, ChainOwner>();

  for (let i = 0; i < rows.length; i += MULTICALL_CHUNK) {
    const chunk = rows.slice(i, i + MULTICALL_CHUNK);
    const base = await client.multicall({
      allowFailure: true,
      contracts: chunk.map(r => ({
        address: BASE_REGISTRAR,
        abi: ownerOfAbi,
        functionName: 'ownerOf' as const,
        args: [BigInt(keccak256(toBytes(r.name.slice(0, -'.eth'.length))))],
      })),
    });

    const wrapped: number[] = [];
    chunk.forEach((r, k) => {
      const baseOwner = base[k].status === 'success' ? (base[k].result as string).toLowerCase() : null;
      out.set(r.id, { baseOwner, owner: baseOwner, wrapped: baseOwner === NAME_WRAPPER });
      if (baseOwner === NAME_WRAPPER) wrapped.push(k);
    });

    if (wrapped.length > 0) {
      const w = await client.multicall({
        allowFailure: true,
        contracts: wrapped.map(k => ({
          address: NAME_WRAPPER as `0x${string}`,
          abi: ownerOfAbi,
          functionName: 'ownerOf' as const,
          args: [BigInt(namehash(chunk[k].name))],
        })),
      });
      wrapped.forEach((k, j) => {
        const entry = out.get(chunk[k].id)!;
        entry.owner = w[j].status === 'success' ? (w[j].result as string).toLowerCase() : null;
      });
    }

    process.stdout.write(`\r  chain: ${Math.min(i + MULTICALL_CHUNK, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');
  return out;
}

/** Owner as the stale ENSNode reports it, using the same rules as validate-ens-data-v2. */
async function readStaleOwners(names: string[]): Promise<{ owners: Map<string, string | null>; block: number | null }> {
  const owners = new Map<string, string | null>();
  let block: number | null = null;
  const query = `query($n: [String!]) {
    domains(where: { name_in: $n }) { name owner { id } registrant { id } wrappedOwner { id } }
    _meta { block { number } }
  }`;

  for (let i = 0; i < names.length; i += GRAPH_BATCH) {
    const batch = names.slice(i, i + GRAPH_BATCH);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(STALE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { n: batch } }),
        });
        const json: any = await res.json();
        if (!json.data) throw new Error(JSON.stringify(json.errors ?? json).slice(0, 200));
        block = json.data._meta?.block?.number ?? block;
        for (const d of json.data.domains) {
          const owner = d.owner?.id?.toLowerCase();
          let value: string | null;
          if (owner === NAME_WRAPPER && d.wrappedOwner) value = d.wrappedOwner.id.toLowerCase();
          else value = (d.registrant?.id || d.owner?.id || '').toLowerCase() || null;
          owners.set(d.name, value);
        }
        break;
      } catch (error: any) {
        if (attempt >= GRAPH_RETRIES) {
          console.warn(`\n  stale ENSNode batch failed (${batch[0]}…): ${error.message}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    process.stdout.write(`\r  stale ENSNode: ${Math.min(i + GRAPH_BATCH, names.length)}/${names.length}`);
  }
  process.stdout.write('\n');
  return { owners, block };
}

// --- Main ---

async function main() {
  const dbUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  console.log('Repair owners reverted from the frozen Railway ENSNode');
  console.log(`  target DB:   ${dbUrl ? `${dbUrl.host}${dbUrl.pathname}` : '(DATABASE_URL unset)'}`);
  console.log(`  mode:        ${APPLY ? 'APPLY (writes)' : 'dry run'}`);
  console.log(`  scope:       ${NAMES?.length ? `${NAMES.length} named` : `v1 names with activity after block ${FROM_BLOCK}`}`);
  console.log(`  fix rule:    ${ANY_MISMATCH ? 'any chain mismatch' : 'DB owner == stale ENSNode owner'}`);

  const candidates = await loadCandidates();
  console.log(`Loaded ${candidates.length} candidates`);

  const chain = await readChainOwners(candidates);
  const mismatched = candidates.filter(c => {
    const o = chain.get(c.id);
    return o?.owner && o.owner !== ZERO_ADDRESS && o.owner !== NAME_WRAPPER && o.baseOwner
      && (c.owner_address?.toLowerCase() ?? null) !== o.owner;
  });
  console.log(`DB owner differs from chain: ${mismatched.length}`);

  const { owners: stale, block: staleBlock } = await readStaleOwners(mismatched.map(c => c.name));
  console.log(`Stale ENSNode block: ${staleBlock ?? 'unknown'}`);

  const plan: PlanRow[] = [];
  const leftAlone: Array<{ name: string; db: string | null; chain: string | null; stale: string | null }> = [];
  for (const c of mismatched) {
    const o = chain.get(c.id)!;
    const staleOwner = stale.get(c.name) ?? null;
    const dbOwner = c.owner_address?.toLowerCase() ?? null;
    if (!ANY_MISMATCH && dbOwner !== staleOwner) {
      leftAlone.push({ name: c.name, db: dbOwner, chain: o.owner, stale: staleOwner });
      continue;
    }
    plan.push({
      id: c.id,
      name: c.name,
      dbOwner,
      dbRegistrant: c.registrant?.toLowerCase() ?? null,
      staleOwner,
      newOwner: o.owner!,
      newRegistrant: o.baseOwner!,
      wrapped: o.wrapped,
    });
  }

  console.log(`\nPlanned repairs: ${plan.length} (${plan.filter(p => p.wrapped).length} wrapped)`);
  for (const p of plan.slice(0, 15)) {
    console.log(`  ${p.name}: ${p.dbOwner} -> ${p.newOwner}${p.wrapped ? ' (wrapped)' : ''}`);
  }
  if (plan.length > 15) console.log(`  … ${plan.length - 15} more`);
  if (leftAlone.length > 0) {
    console.log(`\nMismatches NOT matching the stale ENSNode (left alone, use --any-mismatch to include): ${leftAlone.length}`);
    for (const l of leftAlone.slice(0, 10)) console.log(`  ${l.name}: db=${l.db} chain=${l.chain} stale=${l.stale}`);
  }

  let updated = 0;
  if (APPLY && plan.length > 0) {
    const pool = getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of plan) {
        // Only apply if the row still holds what we read (the indexer may have written since)
        const r = await client.query(
          `UPDATE ens_names
           SET owner_address = $2, registrant = $3, updated_at = NOW()
           WHERE id = $1
             AND COALESCE(ens_version, 1) = 1
             AND owner_address IS NOT DISTINCT FROM $4`,
          [p.id, p.newOwner, p.newRegistrant, p.dbOwner]
        );
        updated += r.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    console.log(`\nUpdated ${updated} of ${plan.length} rows`);
  } else if (!APPLY) {
    console.log('\nDry run: nothing written. Re-run with --apply to write.');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    ranAt: new Date().toISOString(),
    apply: APPLY,
    fromBlock: FROM_BLOCK,
    staleUrl: STALE_URL,
    staleBlock,
    candidates: candidates.length,
    mismatched: mismatched.length,
    updated,
    plan,
    leftAlone,
  }, null, 1));
  console.log(`Plan written to ${OUT}`);
}

main()
  .catch(error => {
    console.error('Repair failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeAllConnections());
