#!/usr/bin/env node

/**
 * Compare two ENSNode instances for data parity
 *
 * Read-only. Samples names from ens_names (most recently updated + edge-case
 * strata), replays the subgraph query shapes the backend and app actually use
 * against both instances, normalizes and deep-diffs the responses, and reports
 * per-query match rates plus response sizes (for egress estimates).
 *
 * ENSNode does not support `block: { number }` pinning, so each mismatched
 * batch is re-queried (up to --retries times) and only diffs that persist are
 * recorded. `_meta.block.number` from both sides is recorded with every diff.
 *
 * Modes:
 *   sample (default)  Sampled names + account/search queries
 *   --full-scan       Paginate every domain by id on both sides and compare
 *
 * Usage:
 *   npm run compare-ensnode -- [options]
 *
 * Options:
 *   --a URL            Instance A (default: Railway prod)
 *   --b URL            Instance B (default: hotbox)
 *   --recent N         Most recently updated names (default: 2000)
 *   --edge N           Names per edge-case stratum (default: 200)
 *   --random N         Uniformly random names from ens_names (default: 0)
 *   --queries LIST     Comma-separated query kinds to run (default: all)
 *                      byName,byId,byLabelhash,manageable,chatSearch,profileSearch
 *   --accounts N       Owner addresses for account queries (default: 100)
 *   --prefixes N       Name prefixes for search queries (default: 50)
 *   --batch N          Names per GraphQL request (default: 20)
 *   --concurrency N    Parallel batches (default: 4)
 *   --retries N        Re-query attempts for mismatches (default: 2)
 *   --full-scan        Run the full domain scan instead of the sample
 *   --page-size N      Full-scan page size (default: 1000)
 *   --max-pages N      Full-scan page cap (default: unlimited)
 *   --from-id HEX      Full-scan starting id (default: 0x0)
 *   --out PATH         Diff output JSONL (default: data/ensnode-compare-<ts>.jsonl)
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import { namehash } from 'viem';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_A = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const DEFAULT_B = 'https://ensnode.on.hotbox.wtf/subgraph';
const ETH_NODE = '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_HTTP_RETRIES = 3;
const RETRY_DELAY_MS = 3_000;

// --- Args ---

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function argInt(flag: string, def: number): number {
  const v = argValue(flag);
  return v ? parseInt(v, 10) : def;
}

const A_URL = argValue('--a') || DEFAULT_A;
const B_URL = argValue('--b') || DEFAULT_B;
const RECENT = argInt('--recent', 2000);
const EDGE = argInt('--edge', 200);
const RANDOM = argInt('--random', 0);
const QUERIES = argValue('--queries')?.split(',').map((q) => q.trim());
const ACCOUNTS = argInt('--accounts', 100);
const PREFIXES = argInt('--prefixes', 50);
const BATCH = argInt('--batch', 20);
const CONCURRENCY = argInt('--concurrency', 4);
const RETRIES = argInt('--retries', 2);
const FULL_SCAN = process.argv.includes('--full-scan');
const PAGE_SIZE = argInt('--page-size', 1000);
const MAX_PAGES = argValue('--max-pages') ? argInt('--max-pages', 0) : Infinity;
const FROM_ID = argValue('--from-id') || '0x0';
const OUT_FILE =
  argValue('--out') ||
  path.join(process.cwd(), 'data', `ensnode-compare-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

// --- Query fragments (union of the selections used across backend + app) ---

// domains(where:{name}) — name-details, ens-metadata, ens-roles, names.ts,
// profiles.ts, workers blockchain.ts, app checkIfWrapped
const DOMAIN_FIELDS = `
  id name labelName labelhash createdAt expiryDate
  owner { id } registrant { id } wrappedOwner { id } resolvedAddress { id }
  resolver {
    id address texts coinTypes contentHash
    addr { id }
    textChangeds { key value }
    multicoinAddrChangeds { coinType addr }
    contenthashChangeds { hash }
  }
  wrappedDomain { owner { id } fuses expiryDate }
  registration { registrant { id } expiryDate registrationDate }
`;

// domains(where:{labelhash, parent: eth}) — ens-resolver, workers blockchain.ts, app fetchDomains
const LABEL_FIELDS = `id name labelName labelhash registration { expiryDate registrationDate }`;

// ENSNode rejects queries over 1000 GraphQL tokens, so batched selections
// reference named fragments instead of repeating the field list per alias
const FRAGMENTS: Record<string, string> = {
  D: `fragment D on Domain { ${DOMAIN_FIELDS} }`,
  L: `fragment L on Domain { ${LABEL_FIELDS} }`,
};

function withFragments(body: string): string {
  const used = Object.keys(FRAGMENTS).filter((k) => body.includes(`...${k} `) || body.includes(`...${k}}`));
  return [...used.map((k) => FRAGMENTS[k]), body].join('\n');
}

// Full-scan selection: the ownership/expiry fields grails depends on
const SCAN_FIELDS = `
  id name labelName labelhash createdAt expiryDate
  owner { id } registrant { id } wrappedOwner { id } resolvedAddress { id }
  resolver { id }
  registration { expiryDate registrationDate }
`;

// --- Types ---

interface SampleName {
  name: string;
  tokenId: string;
  owner: string;
  tags: string[];
}

type QueryKind =
  | 'byName'
  | 'byId'
  | 'byLabelhash'
  | 'manageable'
  | 'chatSearch'
  | 'profileSearch'
  | 'fullScan';

interface GqlResult {
  data: any;
  errors: any[] | null;
  bytes: number;
  ms: number;
  httpError?: string;
}

interface Stats {
  compared: number;
  matched: number;
  mismatched: number;
  transient: number; // differed initially but matched on re-query
  buckets: Record<string, number>;
  bytesA: number;
  bytesB: number;
  requests: number;
  msA: number;
  msB: number;
}

const stats = new Map<QueryKind, Stats>();
const runs = (kind: QueryKind) => !QUERIES || QUERIES.includes(kind);
function statFor(kind: QueryKind): Stats {
  let s = stats.get(kind);
  if (!s) {
    s = { compared: 0, matched: 0, mismatched: 0, transient: 0, buckets: {}, bytesA: 0, bytesB: 0, requests: 0, msA: 0, msB: 0 };
    stats.set(kind, s);
  }
  return s;
}

let out: fs.WriteStream;
let shuttingDown = false;

// --- HTTP ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql(url: string, query: string, variables?: Record<string, any>): Promise<GqlResult> {
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_HTTP_RETRIES; attempt++) {
    const started = Date.now();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await resp.text();
      const ms = Date.now() - started;
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}: ${text.slice(0, 200)}`;
      } else {
        const json = JSON.parse(text);
        return { data: json.data ?? null, errors: json.errors ?? null, bytes: Buffer.byteLength(text), ms };
      }
    } catch (e: any) {
      lastErr = e?.message || String(e);
    }
    await sleep(RETRY_DELAY_MS * (attempt + 1));
  }
  return { data: null, errors: null, bytes: 0, ms: 0, httpError: lastErr };
}

async function both(query: string, variables?: Record<string, any>): Promise<[GqlResult, GqlResult]> {
  return Promise.all([gql(A_URL, query, variables), gql(B_URL, query, variables)]);
}

async function metaBlocks(): Promise<[number | null, number | null]> {
  const q = '{ _meta { block { number } } }';
  const [a, b] = await both(q);
  return [a.data?._meta?.block?.number ?? null, b.data?._meta?.block?.number ?? null];
}

// --- Normalization + diff ---

function normalize(v: any): any {
  if (Array.isArray(v)) {
    const items = v.map(normalize);
    return items
      .map((x) => [JSON.stringify(x), x] as const)
      .sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
      .map((p) => p[1]);
  }
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) o[k] = normalize(v[k]);
    return o;
  }
  if (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v)) return v.toLowerCase();
  return v;
}

interface FieldDiff {
  path: string;
  a: any;
  b: any;
}

function deepDiff(a: any, b: any, p = ''): FieldDiff[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (x: any) => x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => deepDiff(a[k], b[k], p ? `${p}.${k}` : k));
  }
  return [{ path: p || '(root)', a, b }];
}

const HASH_LABEL = /\[[0-9a-f]{64}\]/;

function classify(diffs: FieldDiff[]): string {
  const d = diffs[0];
  const empty = (x: any) => x === null || x === undefined || (Array.isArray(x) && x.length === 0);
  if (diffs.length === 1 && d.path === '(root)' && (empty(d.a) || empty(d.b))) {
    return empty(d.a) ? 'missing_in_a' : 'missing_in_b';
  }
  if (
    diffs.every(
      (x) => typeof x.a === 'string' && typeof x.b === 'string' && HASH_LABEL.test(x.a) !== HASH_LABEL.test(x.b)
    )
  ) {
    return 'label_heal';
  }
  if (diffs.some((x) => Array.isArray(x.a) || Array.isArray(x.b))) return 'list_diff';
  if (diffs.some((x) => empty(x.a) !== empty(x.b))) return 'field_missing';
  return 'field_value';
}

// --- Generic batched compare ---

interface Item {
  key: string; // what we report on (name / address / prefix)
  alias: string;
  selection: string; // full aliased selection for this item
  meta?: Record<string, any>;
}

async function compareItems(kind: QueryKind, items: Item[], attempt = 0, isolated = false): Promise<void> {
  if (items.length === 0 || shuttingDown) return;
  const query = withFragments(`{ ${items.map((i) => i.selection).join('\n')} }`);
  const [ra, rb] = await both(query);
  const s = statFor(kind);
  s.requests++;
  s.bytesA += ra.bytes;
  s.bytesB += rb.bytes;
  s.msA += ra.ms;
  s.msB += rb.ms;

  // Whole-request failures / GraphQL errors
  if (ra.httpError || rb.httpError || ra.errors || rb.errors) {
    const sameErrors =
      !ra.httpError && !rb.httpError && JSON.stringify(normalize(ra.errors)) === JSON.stringify(normalize(rb.errors));
    if (process.env.DEBUG) {
      console.error(`\n[${kind} x${items.length} attempt ${attempt}]`, JSON.stringify(ra.httpError || ra.errors).slice(0, 500));
    }
    if (!sameErrors && attempt < RETRIES) {
      await sleep(RETRY_DELAY_MS);
      return compareItems(kind, items, attempt + 1);
    }
    // One bad item can poison an aliased batch; isolate before recording
    if (items.length > 1) {
      for (const it of items) await compareItems(kind, [it], RETRIES, true);
      return;
    }
    // Identical errors on both sides are parity, but still not a usable answer — record them
    const bucket = ra.httpError || rb.httpError ? 'request_failed' : sameErrors ? 'error_both' : 'error_one_side';
    s.compared++;
    if (sameErrors) s.matched++;
    else s.mismatched++;
    s.buckets[bucket] = (s.buckets[bucket] || 0) + 1;
    write({
      kind,
      key: items[0].key,
      bucket,
      meta: items[0].meta,
      a: ra.httpError || ra.errors,
      b: rb.httpError || rb.errors,
    });
    return;
  }

  const mismatched: Item[] = [];
  const results: { item: Item; diffs: FieldDiff[] }[] = [];
  for (const it of items) {
    const diffs = deepDiff(normalize(ra.data?.[it.alias]), normalize(rb.data?.[it.alias]));
    if (diffs.length) {
      mismatched.push(it);
      results.push({ item: it, diffs });
    } else {
      s.compared++;
      s.matched++;
      if (attempt > 0 && !isolated) s.transient++;
    }
  }
  if (mismatched.length === 0) return;

  if (attempt < RETRIES) {
    await sleep(RETRY_DELAY_MS);
    return compareItems(kind, mismatched, attempt + 1, isolated);
  }

  const [blockA, blockB] = await metaBlocks();
  for (const { item, diffs } of results) {
    const bucket = classify(diffs);
    s.compared++;
    s.mismatched++;
    s.buckets[bucket] = (s.buckets[bucket] || 0) + 1;
    write({ kind, key: item.key, bucket, meta: item.meta, blockA, blockB, diffs: diffs.slice(0, 20) });
  }
}

function write(rec: Record<string, any>) {
  out.write(JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
}

async function runPool<T>(tasks: T[], fn: (t: T) => Promise<void>, label: string) {
  let next = 0;
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < tasks.length && !shuttingDown) {
      const t = tasks[next++];
      await fn(t);
      done++;
      if (done % 10 === 0 || done === tasks.length) {
        const rate = done / ((Date.now() - started) / 1000);
        const eta = Math.round((tasks.length - done) / Math.max(rate, 0.001));
        process.stdout.write(`\r  ${label}: ${done}/${tasks.length} batches (eta ${eta}s)   `);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  process.stdout.write('\n');
}

function chunk<T>(arr: T[], n: number): T[][] {
  const res: T[][] = [];
  for (let i = 0; i < arr.length; i += n) res.push(arr.slice(i, i + n));
  return res;
}

const lit = (s: string) => JSON.stringify(s);

// --- Sampling ---

async function loadSample(): Promise<SampleName[]> {
  const pool = getPostgresPool();
  const strata: { tag: string; sql: string; limit: number }[] = [
    { tag: 'recent', sql: `ORDER BY updated_at DESC`, limit: RECENT },
    { tag: 'random', sql: `ORDER BY random()`, limit: RANDOM },
    {
      tag: 'wrapped',
      sql: `WHERE lower(registrant) = '${NAME_WRAPPER_ADDRESS}' OR lower(owner_address) = '${NAME_WRAPPER_ADDRESS}' ORDER BY updated_at DESC`,
      limit: EDGE,
    },
    { tag: 'subname', sql: `WHERE name LIKE '%.%.%' ORDER BY updated_at DESC`, limit: EDGE },
    { tag: 'emoji', sql: `WHERE has_emoji = true ORDER BY updated_at DESC`, limit: EDGE },
    { tag: 'keycap', sql: `WHERE name LIKE '%' || chr(8419) || '%' ORDER BY updated_at DESC`, limit: EDGE },
    { tag: 'placeholder', sql: `WHERE name LIKE '[%' ORDER BY updated_at DESC`, limit: EDGE },
    { tag: 'expired', sql: `WHERE expiry_date < NOW() - INTERVAL '90 days' ORDER BY expiry_date DESC`, limit: EDGE },
    {
      tag: 'grace',
      sql: `WHERE expiry_date < NOW() AND expiry_date >= NOW() - INTERVAL '90 days' ORDER BY expiry_date DESC`,
      limit: EDGE,
    },
    {
      tag: 'registered_24h',
      sql: `WHERE registration_date >= NOW() - INTERVAL '24 hours' ORDER BY registration_date DESC`,
      limit: EDGE,
    },
    { tag: 'has_resolver', sql: `WHERE resolver_address IS NOT NULL ORDER BY metadata_updated_at DESC NULLS LAST`, limit: EDGE },
  ];

  const byName = new Map<string, SampleName>();
  for (const st of strata) {
    const { rows } = await pool.query(
      `SELECT name, token_id, owner_address FROM ens_names ${st.sql} LIMIT $1`,
      [st.limit]
    );
    console.log(`  ${st.tag}: ${rows.length}`);
    for (const r of rows) {
      const existing = byName.get(r.name);
      if (existing) existing.tags.push(st.tag);
      else byName.set(r.name, { name: r.name, tokenId: r.token_id, owner: (r.owner_address || '').toLowerCase(), tags: [st.tag] });
    }
  }
  return [...byName.values()];
}

function tokenIdToHex(tokenId: string): string | null {
  try {
    return '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
  } catch {
    return null;
  }
}

function safeNamehash(name: string): string | null {
  try {
    return namehash(name);
  } catch {
    return null;
  }
}

// --- Sample mode ---

async function runSample() {
  console.log('Loading sample from ens_names...');
  const names = await loadSample();
  console.log(`  unique names: ${names.length}\n`);

  // 1. domains(where:{name}) — superset selection
  const byNameBatches = chunk(names, BATCH).map((b) =>
    b.map((n, i) => ({
      key: n.name,
      alias: `n${i}`,
      selection: `n${i}: domains(where: { name: ${lit(n.name)} }) { ...D }`,
      meta: { tags: n.tags },
    }))
  );
  if (runs('byName')) await runPool(byNameBatches, (b) => compareItems('byName', b), 'byName');

  // 2. domain(id: namehash)
  const idItems = names
    .map((n) => ({ n, id: safeNamehash(n.name) }))
    .filter((x) => x.id)
    .map((x) => ({ n: x.n, id: x.id as string }));
  const byIdBatches = chunk(idItems, BATCH).map((b) =>
    b.map(({ n, id }, i) => ({
      key: n.name,
      alias: `d${i}`,
      selection: `d${i}: domain(id: ${lit(id)}) { ...D }`,
      meta: { tags: n.tags, id },
    }))
  );
  if (runs('byId')) await runPool(byIdBatches, (b) => compareItems('byId', b), 'byId');

  // 3. domains(where:{labelhash, parent: eth}) for 2LDs — labelhash from token_id
  const labelItems = names
    .filter((n) => /^[^.]+\.eth$/.test(n.name))
    .map((n) => ({ n, lh: tokenIdToHex(n.tokenId) }))
    .filter((x) => x.lh)
    .map((x) => ({ n: x.n, lh: x.lh as string }));
  const byLabelBatches = chunk(labelItems, BATCH).map((b) =>
    b.map(({ n, lh }, i) => ({
      key: n.name,
      alias: `l${i}`,
      selection: `l${i}: domains(where: { labelhash: ${lit(lh)}, parent: ${lit(ETH_NODE)} }, first: 5) { ...L }`,
      meta: { tags: n.tags, labelhash: lh },
    }))
  );
  if (runs('byLabelhash')) await runPool(byLabelBatches, (b) => compareItems('byLabelhash', b), 'byLabelhash');

  // 4. GetManageableNames per owner (ens-roles.ts) — one address per request, these can be large
  const owners = [...new Set(names.map((n) => n.owner).filter((o) => /^0x[0-9a-f]{40}$/.test(o) && o !== NAME_WRAPPER_ADDRESS))].slice(
    0,
    ACCOUNTS
  );
  // orderBy: id added so a >1000-name owner gets the same truncated page on both sides
  const manageable = owners.map((addr) => [
    {
      key: `${addr}:asManager`,
      alias: 'asManager',
      selection: `asManager: domains(where: { owner: ${lit(addr)} }, first: 1000, orderBy: id) { name registrant { id } wrappedOwner { id } }`,
    },
    {
      key: `${addr}:asOwner`,
      alias: 'asOwner',
      selection: `asOwner: domains(where: { registrant: ${lit(addr)} }, first: 1000, orderBy: id) { name owner { id } }`,
    },
    {
      key: `${addr}:asWrappedOwner`,
      alias: 'asWrappedOwner',
      selection: `asWrappedOwner: domains(where: { wrappedOwner: ${lit(addr)} }, first: 1000, orderBy: id) { name wrappedDomain { fuses } }`,
    },
  ]);
  if (runs('manageable')) await runPool(manageable, (b) => compareItems('manageable', b), 'manageable');

  // 5. Chat search (chats.ts) + profile search (app search-profiles.ts) on name prefixes
  const prefixSource = names.filter((n) => /^[a-z0-9]{4,}\.eth$/.test(n.name));
  const prefixes = [...new Set(prefixSource.map((n) => n.name.slice(0, 4)))].slice(0, PREFIXES);
  const ownersByPrefix = new Map<string, string[]>();
  for (const n of prefixSource) {
    const p = n.name.slice(0, 4);
    if (!ownersByPrefix.has(p)) ownersByPrefix.set(p, []);
    ownersByPrefix.get(p)!.push(n.owner);
  }
  const chatBatches = chunk(prefixes, BATCH).map((b) =>
    b.map((p, i) => ({
      key: p,
      alias: `c${i}`,
      selection: `c${i}: domains(first: 1000, orderBy: id, where: { name_starts_with: ${lit(p)}, resolvedAddressId_in: ${JSON.stringify(
        ownersByPrefix.get(p) || []
      )} }) { resolvedAddress { id } }`,
    }))
  );
  if (runs('chatSearch')) await runPool(chatBatches, (b) => compareItems('chatSearch', b), 'chatSearch');

  const profileBatches = chunk(prefixes, BATCH).map((b) =>
    b.map((p, i) => ({
      key: p,
      alias: `p${i}`,
      selection: `p${i}: domains(where: { and: [{ name_starts_with: ${lit(p)} }] }, orderBy: labelName, orderDirection: asc) { name resolvedAddress { id } }`,
    }))
  );
  if (runs('profileSearch')) await runPool(profileBatches, (b) => compareItems('profileSearch', b), 'profileSearch');
}

// --- Full-scan mode ---

async function runFullScan() {
  console.log(`Full scan of domains from id ${FROM_ID} (page ${PAGE_SIZE})...`);
  const s = statFor('fullScan');
  const query = `query Page($last: String!) {
    domains(first: ${PAGE_SIZE}, orderBy: id, orderDirection: asc, where: { id_gt: $last }) { ${SCAN_FIELDS} }
  }`;
  let cursor = FROM_ID;
  let pages = 0;
  const started = Date.now();

  while (!shuttingDown && pages < MAX_PAGES) {
    const [ra, rb] = await both(query, { last: cursor });
    s.requests++;
    s.bytesA += ra.bytes;
    s.bytesB += rb.bytes;
    s.msA += ra.ms;
    s.msB += rb.ms;
    if (ra.httpError || rb.httpError || ra.errors || rb.errors) {
      console.error(`\nPage after ${cursor} failed:`, ra.httpError || ra.errors, rb.httpError || rb.errors);
      write({ kind: 'fullScan', bucket: 'request_failed', key: cursor, a: ra.httpError || ra.errors, b: rb.httpError || rb.errors });
      console.error(`Resume with --from-id ${cursor}`);
      break;
    }
    const pa: any[] = ra.data?.domains || [];
    const pb: any[] = rb.data?.domains || [];
    if (pa.length === 0 && pb.length === 0) break;

    // Pages can drift if the sets differ: only compare ids up to the smaller
    // page end, then advance the cursor there so both sides stay aligned.
    const endA = pa.length === PAGE_SIZE ? pa[pa.length - 1].id : null;
    const endB = pb.length === PAGE_SIZE ? pb[pb.length - 1].id : null;
    const bound = [endA, endB].filter(Boolean).sort()[0] ?? null;
    const inRange = (d: any) => bound === null || d.id <= bound;
    const mapA = new Map(pa.filter(inRange).map((d) => [d.id, d]));
    const mapB = new Map(pb.filter(inRange).map((d) => [d.id, d]));
    const ids = new Set([...mapA.keys(), ...mapB.keys()]);

    for (const id of ids) {
      const diffs = deepDiff(normalize(mapA.get(id) ?? null), normalize(mapB.get(id) ?? null));
      s.compared++;
      if (diffs.length === 0) {
        s.matched++;
        continue;
      }
      const bucket = classify(diffs);
      s.mismatched++;
      s.buckets[bucket] = (s.buckets[bucket] || 0) + 1;
      write({ kind: 'fullScan', key: id, name: mapA.get(id)?.name ?? mapB.get(id)?.name, bucket, diffs: diffs.slice(0, 20) });
    }

    pages++;
    if (bound === null) break; // both sides returned a short page: done
    cursor = bound;
    const rate = s.compared / ((Date.now() - started) / 1000);
    process.stdout.write(
      `\r  pages ${pages}  compared ${s.compared}  mismatched ${s.mismatched}  (${rate.toFixed(0)}/s)  cursor ${cursor.slice(0, 18)}…   `
    );
  }
  process.stdout.write('\n');
  if (!shuttingDown) console.log(`Last cursor: ${cursor}`);
}

// --- Main ---

function printSummary(blocksStart: [number | null, number | null], blocksEnd: [number | null, number | null]) {
  console.log('\n=== Summary ===');
  console.log(`A: ${A_URL}`);
  console.log(`B: ${B_URL}`);
  console.log(`Blocks at start: A=${blocksStart[0]} B=${blocksStart[1]}   at end: A=${blocksEnd[0]} B=${blocksEnd[1]}\n`);

  const rows = [...stats.entries()].map(([kind, s]) => ({
    query: kind,
    compared: s.compared,
    matched: s.matched,
    mismatched: s.mismatched,
    'match %': s.compared ? ((100 * s.matched) / s.compared).toFixed(3) : '-',
    transient: s.transient,
    buckets: Object.entries(s.buckets)
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
  }));
  console.table(rows);

  console.log('\nResponse sizes (for egress estimates):');
  console.table(
    [...stats.entries()].map(([kind, s]) => {
      const perItem = s.compared ? s.bytesA / s.compared : 0;
      return {
        query: kind,
        requests: s.requests,
        'A total KB': (s.bytesA / 1024).toFixed(1),
        'B total KB': (s.bytesB / 1024).toFixed(1),
        'A bytes/item': perItem.toFixed(0),
        'A avg ms': s.requests ? (s.msA / s.requests).toFixed(0) : '-',
        'B avg ms': s.requests ? (s.msB / s.requests).toFixed(0) : '-',
      };
    })
  );
  console.log(`\nDiffs written to ${OUT_FILE}`);
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  out = fs.createWriteStream(OUT_FILE, { flags: 'a' });

  const onSignal = () => {
    if (shuttingDown) process.exit(1);
    console.log('\nShutting down after in-flight requests...');
    shuttingDown = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const blocksStart = await metaBlocks();
  console.log(`A ${A_URL} block ${blocksStart[0]}`);
  console.log(`B ${B_URL} block ${blocksStart[1]}\n`);
  if (blocksStart[0] === null || blocksStart[1] === null) {
    throw new Error('Could not read _meta from one of the instances');
  }

  if (FULL_SCAN) await runFullScan();
  else await runSample();

  const blocksEnd = await metaBlocks();
  printSummary(blocksStart, blocksEnd);
  await new Promise((r) => out.end(r));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeAllConnections());
