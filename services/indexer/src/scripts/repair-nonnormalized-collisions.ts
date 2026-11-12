/**
 * Repair ens_names rows that picked up another token's state because the v1 indexer mapped a
 * non-normalized label to the normalized name. The registrar hashes labels as given, so
 * "Chinese" is its own token; before the fix in ens-indexer.ts (resolveTokenName /
 * canonicalLabel) its renewal set chinese.eth's expiry to Chinese's and attached the renewal
 * to chinese.eth (2026-10-27, tx 0x154bc3eb…: chinese.eth and wendys.eth shown as premium).
 *
 * 1. Expiry. For every v1 .eth 2LD row, compare expiry_date with
 *    BaseRegistrar.nameExpires(labelhash). Rows whose v1 token isn't held by an ENSv2
 *    migration contract (Graveyard / migration controllers) and differ are set to the chain
 *    value: `timezone_offset` when the row is off by a whole number of hours up to 5 (an old
 *    America/New_York conversion, not a wrong token), `expiry_mismatch` otherwise. Other
 *    differences are only reported.
 * 2. Renewal rows. For each `expiry_mismatch` row, check every renewal tx the row carries
 *    (renewals, activity_history 'renewal', transactions 'renewal'). A tx whose receipt has no
 *    BaseRegistrar NameRenewed for the name's labelhash renewed a different token, so those
 *    rows are deleted.
 * 3. token_id. Rows whose token_id is neither labelhash(name) nor namehash(name) are reported
 *    (the Transfer/NameRegistered paths could swap it). Not changed.
 *
 * Read-only unless --apply. Run it after the indexer fix is deployed, or the running indexer
 * can re-apply a bad event. --chain must match the loaded config's CHAIN_ID; the target chain,
 * database and RPC hosts are printed first. Local runs load the root .env (mainnet prod).
 *
 * Usage (from services/indexer):
 *   npm run repair:nonnormalized-collisions -- --chain 1 [--names chinese.eth,wendys.eth]
 *     [--apply] [--max-fixes 200] [--csv /path/out.csv]
 */

import * as fs from 'fs';
import {
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
  toEventSelector,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem';
import { namehash } from 'viem/ens';
import {
  config,
  viemChain,
  getPostgresPool,
  closeAllConnections,
  safeNormalize,
  isPlaceholderName,
} from '../../../shared/src';

const USAGE =
  'Usage: repair-nonnormalized-collisions --chain <chainId> [--names a.eth,b.eth] [--apply] [--max-fixes N] [--csv out.csv]';

const PAGE = 2000; // rows per DB page
const CALLS = 500; // calls per multicall
const DAY = 86400;

const BASE_REGISTRAR_ABI = parseAbi([
  'function nameExpires(uint256 id) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const NAME_RENEWED_TOPIC = toEventSelector('NameRenewed(uint256,uint256)');

type Category =
  | 'expiry_mismatch' // fixed with --apply
  | 'timezone_offset' // fixed with --apply: off by whole hours (<= 5), an old timezone conversion
  | 'ensv2_held' // v1 token held by the Graveyard / a migration controller: expected
  | 'chain_unregistered' // normalized token never registered on v1
  | 'wrapper_expiry_offset' // DB = chain + 90d (NameWrapper expiry stored): not this bug
  | 'db_expiry_null'
  | 'row_not_normalized'
  | 'token_id_mismatch'
  | 'read_failed';

interface Row {
  id: number;
  name: string;
  token_id: string;
  expiry_date: Date | null;
  owner_address: string | null;
}

interface Finding {
  category: Category;
  row: Row;
  chainExpiry?: bigint;
  chainOwner?: string | null;
}

interface RenewalRef {
  ensNameId: number;
  txHash: string;
  sources: Set<string>;
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chain = get('--chain');
  const names = get('--names');
  const maxFixes = get('--max-fixes');
  return {
    chain: chain === undefined ? undefined : Number(chain),
    names: names
      ? names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => safeNormalize(n.endsWith('.eth') ? n : `${n}.eth`))
      : null,
    apply: argv.includes('--apply'),
    maxFixes: maxFixes === undefined ? 200 : Number(maxFixes),
    csv: get('--csv') ?? null,
  };
}

function host(url: string | undefined): string {
  if (!url) return '(not set)';
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname.length > 1 ? u.pathname : ''}`;
  } catch {
    return '(unparseable)';
  }
}

function labelOf(name: string): string {
  return name.slice(0, -'.eth'.length);
}

export function labelTokenId(label: string): bigint {
  // stringToBytes, not toBytes: toBytes reads a "0x…" label as hex, so "0x7368756e" would
  // hash as "shun". The registrar hashes the label's UTF-8 bytes.
  return BigInt(keccak256(stringToBytes(label)));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function iso(seconds: bigint | number | undefined): string {
  if (seconds === undefined) return '';
  const n = Number(seconds);
  if (n === 0) return '0';
  // Graveyard re-registrations expire near 2^64 s, which no Date can hold: keep raw seconds.
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? String(seconds) : d.toISOString();
}

const FIXABLE = new Set<Category>(['expiry_mismatch', 'timezone_offset']);

/** Off by 1-5 whole hours: the 4h/5h America/New_York offset, or 1h around a DST change. */
function isTimezoneOffset(diffSeconds: bigint): boolean {
  const abs = diffSeconds < 0n ? -diffSeconds : diffSeconds;
  return abs > 0n && abs <= 5n * 3600n && abs % 3600n === 0n;
}

const CSV_HEADER ='category,id,name,db_expiry,chain_expiry,chain_owner,token_id';

function csvLine(f: Finding): string {
  return [
    f.category,
    f.row.id,
    JSON.stringify(f.row.name),
    f.row.expiry_date ? f.row.expiry_date.toISOString() : '',
    iso(f.chainExpiry),
    f.chainOwner ?? '',
    f.row.token_id,
  ].join(',');
}

/**
 * Whether the tx renewed the v1 token `tokenId`: its receipt has a BaseRegistrar NameRenewed
 * with that id. Null when the receipt can't be read.
 */
export async function txRenewedToken(
  client: PublicClient,
  registrar: string,
  txHash: string,
  tokenId: bigint
): Promise<boolean | null> {
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
    return receipt.logs.some(
      (l) =>
        l.address.toLowerCase() === registrar.toLowerCase() &&
        l.topics[0] === NAME_RENEWED_TOPIC &&
        l.topics[1] !== undefined &&
        BigInt(l.topics[1]) === tokenId
    );
  } catch {
    return null;
  }
}

async function multicallChunks<T>(
  client: PublicClient,
  contracts: any[]
): Promise<({ status: 'success'; result: T } | { status: 'failure' })[]> {
  const results = await Promise.all(
    chunk(contracts, CALLS).map((c) =>
      client.multicall({
        allowFailure: true,
        multicallAddress: config.blockchain.multicall3Address as Address,
        contracts: c,
      })
    )
  );
  return results.flat() as any;
}

/** Classify one page of rows against the chain. */
export async function checkRows(
  client: PublicClient,
  rows: Row[],
  ensv2Holders: Set<string>
): Promise<Finding[]> {
  const registrar = config.blockchain.ensRegistrarAddress as Address;
  const findings: Finding[] = [];
  const candidates: { row: Row; tokenId: bigint }[] = [];

  for (const row of rows) {
    const label = labelOf(row.name);
    if (safeNormalize(label) !== label) {
      findings.push({ category: 'row_not_normalized', row });
      continue;
    }
    const tokenId = labelTokenId(label);
    const wrappedId = BigInt(namehash(row.name)).toString();
    if (row.token_id !== tokenId.toString() && row.token_id !== wrappedId) {
      findings.push({ category: 'token_id_mismatch', row });
    }
    candidates.push({ row, tokenId });
  }

  const expiries = await multicallChunks<bigint>(
    client,
    candidates.map((c) => ({
      address: registrar,
      abi: BASE_REGISTRAR_ABI,
      functionName: 'nameExpires',
      args: [c.tokenId],
    }))
  );

  const differing: { row: Row; tokenId: bigint; chainExpiry: bigint }[] = [];
  candidates.forEach((c, i) => {
    const r = expiries[i];
    if (r.status !== 'success') {
      findings.push({ category: 'read_failed', row: c.row });
      return;
    }
    const chainExpiry = r.result;
    if (c.row.expiry_date && BigInt(toSeconds(c.row.expiry_date)) === chainExpiry) return;
    differing.push({ ...c, chainExpiry });
  });
  if (differing.length === 0) return findings;

  // ownerOf reverts for expired tokens; that's fine, those aren't held by ENSv2 contracts.
  const owners = await multicallChunks<string>(
    client,
    differing.map((d) => ({
      address: registrar,
      abi: BASE_REGISTRAR_ABI,
      functionName: 'ownerOf',
      args: [d.tokenId],
    }))
  );

  differing.forEach((d, i) => {
    const o = owners[i];
    const chainOwner = o.status === 'success' ? o.result.toLowerCase() : null;
    const base = { row: d.row, chainExpiry: d.chainExpiry, chainOwner };
    if (chainOwner && ensv2Holders.has(chainOwner)) {
      findings.push({ category: 'ensv2_held', ...base });
    } else if (d.chainExpiry === 0n) {
      findings.push({ category: 'chain_unregistered', ...base });
    } else if (!d.row.expiry_date) {
      findings.push({ category: 'db_expiry_null', ...base });
    } else if (BigInt(toSeconds(d.row.expiry_date)) === d.chainExpiry + BigInt(90 * DAY)) {
      findings.push({ category: 'wrapper_expiry_offset', ...base });
    } else if (isTimezoneOffset(BigInt(toSeconds(d.row.expiry_date)) - d.chainExpiry)) {
      findings.push({ category: 'timezone_offset', ...base });
    } else {
      findings.push({ category: 'expiry_mismatch', ...base });
    }
  });
  return findings;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.chain === undefined || Number.isNaN(args.chain) || Number.isNaN(args.maxFixes)) {
    console.error(USAGE);
    process.exit(1);
  }
  if (args.chain !== config.blockchain.chainId) {
    console.error(
      `Refusing to run: --chain ${args.chain} but the loaded config is chain ${config.blockchain.chainId} ` +
        `(database ${host(config.database.url)}). Check which environment variables / .env this shell is using.`
    );
    process.exit(1);
  }

  console.log(`Mode:      ${args.apply ? 'APPLY (writes)' : 'DRY RUN (read-only)'}`);
  console.log(`Chain:     ${config.blockchain.chainId}`);
  console.log(`Database:  ${host(config.database.url)}`);
  console.log(`RPC:       ${host(config.blockchain.rpcUrl)}`);
  console.log(`Registrar: ${config.blockchain.ensRegistrarAddress}`);
  console.log(`Scope:     ${args.names ? args.names.join(', ') : 'all v1 .eth 2LD rows'}\n`);

  const client = createPublicClient({ chain: viemChain, transport: http(config.blockchain.rpcUrl) }) as PublicClient;
  const pool = getPostgresPool();
  const ensv2 = config.blockchain.ensv2;
  const ensv2Holders = new Set(
    ensv2
      ? [ensv2.graveyardAddress, ensv2.unlockedMigrationControllerAddress, ensv2.lockedMigrationControllerAddress].map((a) =>
          a.toLowerCase()
        )
      : []
  );

  // ---- Step 1 + 3: sweep rows -------------------------------------------------------------
  const ROW_FILTER = `ens_version = 1
      AND name LIKE '%.eth' AND name NOT LIKE '%.%.eth'
      AND name NOT LIKE 'token-%' AND name NOT LIKE '#%' AND name NOT LIKE '[%'`;
  const findings: Finding[] = [];
  let scanned = 0;
  let mismatches = 0;
  let namedRows: Row[] = [];

  // The CSV is appended page by page, so a long sweep that dies or is stopped keeps what it found.
  const csvFd = args.csv ? fs.openSync(args.csv, 'w') : null;
  if (csvFd !== null) fs.writeSync(csvFd, `${CSV_HEADER}\n`);
  const record = (found: Finding[]) => {
    for (const f of found) {
      findings.push(f);
      if (FIXABLE.has(f.category)) mismatches++;
    }
    if (csvFd !== null && found.length > 0) fs.writeSync(csvFd, found.map(csvLine).join('\n') + '\n');
  };

  if (args.names) {
    const { rows } = await pool.query<Row & { ens_version: number }>(
      `SELECT id, name, token_id, expiry_date, owner_address, ens_version FROM ens_names WHERE name = ANY($1)`,
      [args.names]
    );
    for (const n of args.names) {
      const r = rows.find((x) => x.name === n);
      if (!r) console.log(`  ${n}: no ens_names row`);
      else if (Number(r.ens_version) !== 1) console.log(`  ${n}: ens_version ${r.ens_version}, skipped (v1 rows only)`);
    }
    namedRows = rows.filter((r) => Number(r.ens_version) === 1 && !isPlaceholderName(r.name));
    record(await checkRows(client, namedRows, ensv2Holders));
    scanned = namedRows.length;
  } else {
    let lastId = 0;
    for (;;) {
      const { rows } = await pool.query<Row>(
        `SELECT id, name, token_id, expiry_date, owner_address FROM ens_names
          WHERE ${ROW_FILTER} AND id > $1 ORDER BY id LIMIT $2`,
        [lastId, PAGE]
      );
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;
      const page = rows.filter((r) => !isPlaceholderName(r.name));
      record(await checkRows(client, page, ensv2Holders));
      scanned += rows.length;
      process.stdout.write(`  scanned ${scanned} rows (last id ${lastId}), expiry mismatches so far: ${mismatches}\r`);
    }
    process.stdout.write('\n');
  }
  if (csvFd !== null) {
    fs.closeSync(csvFd);
    console.log(`Wrote ${findings.length} findings to ${args.csv}`);
  }

  const byCategory = new Map<Category, Finding[]>();
  for (const f of findings) {
    const list = byCategory.get(f.category);
    if (list) list.push(f);
    else byCategory.set(f.category, [f]);
  }

  console.log(`\nScanned ${scanned} rows. Findings:`);
  for (const [cat, list] of [...byCategory].sort()) console.log(`  ${String(list.length).padStart(7)}  ${cat}`);

  for (const [cat, list] of [...byCategory].sort()) {
    console.log(`\n${cat}${FIXABLE.has(cat) ? ' (fixed with --apply)' : ' (report only)'}:`);
    for (const f of list.slice(0, 30)) {
      const db = f.row.expiry_date ? f.row.expiry_date.toISOString() : 'null';
      const chain = f.chainExpiry !== undefined ? ` chain ${iso(f.chainExpiry)}` : '';
      const owner = f.chainOwner !== undefined ? ` chainOwner ${f.chainOwner ?? '(expired)'}` : '';
      console.log(`  #${f.row.id} ${f.row.name}  db ${db}${chain}${owner}  token_id ${f.row.token_id}`);
    }
    if (list.length > 30) console.log(`  ...and ${list.length - 30} more`);
  }

  // ---- Step 2: renewal rows that belong to another token ----------------------------------
  const fixes = findings.filter((f) => FIXABLE.has(f.category));
  // Only expiry_mismatch rows can carry another token's renewals; a timezone shift can't.
  const renewalTargets = new Map<number, { row: Row; tokenId: bigint }>();
  for (const f of byCategory.get('expiry_mismatch') ?? []) {
    renewalTargets.set(f.row.id, { row: f.row, tokenId: labelTokenId(labelOf(f.row.name)) });
  }

  const bogus: RenewalRef[] = [];
  let unreadable = 0;
  if (renewalTargets.size > 0) {
    const { rows: refs } = await pool.query<{ ens_name_id: number; transaction_hash: string; src: string }>(
      `SELECT ens_name_id, lower(transaction_hash) AS transaction_hash, 'renewals' AS src
         FROM renewals WHERE ens_name_id = ANY($1)
       UNION ALL
       SELECT ens_name_id, lower(transaction_hash), 'activity_history'
         FROM activity_history
        WHERE ens_name_id = ANY($1) AND event_type = 'renewal' AND transaction_hash IS NOT NULL
       UNION ALL
       SELECT ens_name_id, lower(transaction_hash), 'transactions'
         FROM transactions WHERE ens_name_id = ANY($1) AND transaction_type = 'renewal'`,
      [[...renewalTargets.keys()]]
    );
    const grouped = new Map<string, RenewalRef>();
    for (const r of refs) {
      const key = `${r.ens_name_id}:${r.transaction_hash}`;
      const g = grouped.get(key) ?? { ensNameId: r.ens_name_id, txHash: r.transaction_hash, sources: new Set<string>() };
      g.sources.add(r.src);
      grouped.set(key, g);
    }
    console.log(`\nChecking ${grouped.size} renewal txs on ${renewalTargets.size} rows...`);
    for (const ref of grouped.values()) {
      const target = renewalTargets.get(ref.ensNameId)!;
      const ok = await txRenewedToken(client, config.blockchain.ensRegistrarAddress, ref.txHash, target.tokenId);
      if (ok === null) {
        unreadable++;
        console.log(`  ? ${target.row.name} ${ref.txHash}: receipt unreadable, left alone`);
      } else if (!ok) {
        bogus.push(ref);
        console.log(`  x ${target.row.name} ${ref.txHash}: no NameRenewed for this name (${[...ref.sources].join(', ')})`);
      }
    }
    console.log(`Renewal txs for another token: ${bogus.length}${unreadable ? `, unreadable: ${unreadable}` : ''}`);
  }

  if (!args.apply) {
    console.log(`\nDry run: would set expiry on ${fixes.length} rows and delete renewal rows for ${bogus.length} txs. Re-run with --apply to write.`);
    return;
  }
  if (fixes.length > args.maxFixes) {
    console.error(
      `\nRefusing to apply: ${fixes.length} expiry fixes is more than --max-fixes ${args.maxFixes}. ` +
        'Review the list (or --csv) and raise --max-fixes if it is right.'
    );
    process.exitCode = 1;
    return;
  }

  // ---- Apply ------------------------------------------------------------------------------
  const bogusByRow = new Map<number, string[]>();
  for (const b of bogus) {
    const list = bogusByRow.get(b.ensNameId);
    if (list) list.push(b.txHash);
    else bogusByRow.set(b.ensNameId, [b.txHash]);
  }
  const fixById = new Map(fixes.map((f) => [f.row.id, f]));
  const rowIds = new Set([...fixById.keys(), ...bogusByRow.keys()]);

  let expiryUpdated = 0;
  let expiryRaced = 0;
  let renewalRowsDeleted = 0;
  for (const id of rowIds) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const fix = fixById.get(id);
      if (fix) {
        // Only if the row still has the value we compared against (the indexer may have moved it).
        const res = await db.query(
          `UPDATE ens_names SET expiry_date = $2, updated_at = NOW()
            WHERE id = $1 AND expiry_date IS NOT DISTINCT FROM $3`,
          [id, new Date(Number(fix.chainExpiry!) * 1000), fix.row.expiry_date]
        );
        if (res.rowCount) expiryUpdated++;
        else {
          expiryRaced++;
          console.log(`  #${id} ${fix.row.name}: expiry changed since the scan, left alone`);
        }
      }
      for (const tx of bogusByRow.get(id) ?? []) {
        const r1 = await db.query(`DELETE FROM renewals WHERE ens_name_id = $1 AND lower(transaction_hash) = $2`, [id, tx]);
        const r2 = await db.query(
          `DELETE FROM activity_history WHERE ens_name_id = $1 AND event_type = 'renewal' AND lower(transaction_hash) = $2`,
          [id, tx]
        );
        const r3 = await db.query(
          `DELETE FROM transactions WHERE ens_name_id = $1 AND transaction_type = 'renewal' AND lower(transaction_hash) = $2`,
          [id, tx]
        );
        renewalRowsDeleted += (r1.rowCount ?? 0) + (r2.rowCount ?? 0) + (r3.rowCount ?? 0);
      }
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }

  console.log(
    `\nApplied: expiry set on ${expiryUpdated} rows${expiryRaced ? ` (${expiryRaced} skipped, changed since scan)` : ''}, ` +
      `${renewalRowsDeleted} renewal rows deleted. Elasticsearch picks up the expiry changes via the wal-listener.`
  );
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => closeAllConnections());
}
