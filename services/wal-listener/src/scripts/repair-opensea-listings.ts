#!/usr/bin/env node
/**
 * Repair OpenSea listings that are live on OpenSea but missing or wrongly cancelled on Grails.
 *
 * Reads every active listing in the OpenSea collections we follow, then for each one that
 * isn't active on Grails:
 *   - not in our listings table at all -> insert it
 *   - in the table as `cancelled`      -> reactivate it with the order from OpenSea
 * Other states (unfunded, expired, sold) are left to the workers that own them.
 *
 * A listing is only planned when it can actually be bought right now:
 *   - its NFT is the name's current token (v2: current ETHRegistry token ID; v1: the
 *     ens_names token, not a v1 token of a name that moved to v2)
 *   - the seller owns the name (v2: on chain, with transfer roles and the conduit approved;
 *     v1: our ens_names owner) and the name hasn't expired
 *   - it has started, ends more than 5 minutes from now, and Seaport doesn't have it as
 *     cancelled or filled, and the seller's Seaport counter still matches
 *   - the seller has no other active OpenSea listing on the name (the OpenSea stream keeps
 *     one per seller per name; a Grails listing alongside it is fine); among several
 *     candidates only the newest is kept
 *
 * Inserted listings get a "listed" activity entry and notify watchers, like any new listing
 * (wal-listener). Reactivated ones only re-sync search.
 *
 * Read-only unless --apply. Uses the root .env (production DB) unless SKIP_DOTENV=true, the
 * OpenSea key from OPENSEA_API_KEY and the RPC from RPC_URL; set either in the environment to
 * override the .env value.
 *
 * Usage (from services/wal-listener):
 *   npm run repair-opensea-listings                                # dry run, ENSv2 listings
 *   npm run repair-opensea-listings -- --include-v1                # also v1 listings
 *   npm run repair-opensea-listings -- --since 2026-10-26 --apply  # write the changes
 *
 * Options:
 *   --apply            write the planned inserts and reactivations
 *   --include-v1       also repair BaseRegistrar / NameWrapper listings (v1 names)
 *   --since DATE       only listings created on OpenSea on or after DATE (UTC)
 *   --max-pages N      stop after N pages of 100 per collection (default 1000)
 *   --concurrency N    parallel on-chain checks (default 4)
 *   --json FILE        write the full plan and skip list to FILE
 *   --verbose          print every planned listing (default: the first 50)
 */

import fs from 'fs';
import { createPublicClient, formatUnits, http, parseAbi } from 'viem';
import {
  config,
  viemChain,
  getPostgresPool,
  closeAllConnections,
  getOpenSeaCollectionSlugs,
  isEthRegistryToken,
  findEnsV2NameByTokenId,
  getOrderNftItem,
  checkEnsV2OrderItem,
  checkEnsV2Transferable,
  getOrderOperator,
} from '../../../shared/src';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PAGE_DELAY_MS = 250;
const MIN_REMAINING_SECONDS = 300;

const SEAPORT_ABI = parseAbi([
  'function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)',
  'function getCounter(address offerer) view returns (uint256 counter)',
]);

interface SeaportItem {
  itemType: number | string;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

interface OpenSeaListing {
  order_hash: string;
  status: string;
  order_created_at: number;
  protocol_address?: string;
  asset: { identifier: string; contract: string } | null;
  price: { current: { currency: string; decimals: number; value: string } };
  protocol_data: {
    parameters: {
      offerer: string;
      offer: SeaportItem[];
      consideration: Array<SeaportItem & { recipient: string }>;
      startTime: string;
      endTime: string;
      conduitKey: string;
      counter: string | number;
    };
    signature: string;
  };
}

interface Candidate {
  action: 'insert' | 'reactivate';
  listing: OpenSeaListing;
  version: 1 | 2;
  tokenId: string;
  seller: string;
  rowId?: number;
  previous?: string;
  ensNameId?: number;
  name?: string;
}

interface Args {
  apply: boolean;
  includeV1: boolean;
  since?: number;
  maxPages: number;
  concurrency: number;
  json?: string;
  verbose: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = value('--since');
  const sinceMs = since ? Date.parse(`${since}T00:00:00Z`) : undefined;
  if (since && Number.isNaN(sinceMs)) {
    throw new Error(`--since must be a date like 2026-10-26, got "${since}"`);
  }
  return {
    apply: argv.includes('--apply'),
    includeV1: argv.includes('--include-v1'),
    since: sinceMs !== undefined ? sinceMs / 1000 : undefined,
    maxPages: parseInt(value('--max-pages') || '1000', 10),
    concurrency: parseInt(value('--concurrency') || '4', 10),
    json: value('--json'),
    verbose: argv.includes('--verbose'),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOpenSeaPage(url: string): Promise<{ listings?: OpenSeaListing[]; next?: string }> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      headers: { 'X-API-KEY': config.opensea.apiKey!, accept: 'application/json' },
    });
    if (response.ok) return response.json() as Promise<{ listings?: OpenSeaListing[]; next?: string }>;
    const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    if (response.status === 401) {
      throw new Error(`OpenSea rejected the API key (401: ${body}). Set OPENSEA_API_KEY to a working key.`);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`OpenSea listings API error: ${response.status} ${body}`);
  }
}

async function fetchActiveListings(maxPages: number): Promise<OpenSeaListing[]> {
  const listings: OpenSeaListing[] = [];
  for (const slug of getOpenSeaCollectionSlugs()) {
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < maxPages; pages++) {
      let url = `${config.opensea.apiBaseUrl}/listings/collection/${slug}/all?limit=100`;
      if (cursor) url += `&next=${encodeURIComponent(cursor)}`;
      const data = await fetchOpenSeaPage(url);
      listings.push(...(data.listings || []).filter((l) => l.status === 'ACTIVE' && l.asset?.identifier));
      if (pages % 50 === 49) console.log(`  ${slug}: ${pages + 1} pages, ${listings.length} active listings so far`);
      cursor = data.next;
      if (!cursor) break;
      await sleep(PAGE_DELAY_MS);
    }
    console.log(`  ${slug}: ${pages + 1} pages read${cursor ? ` (stopped at --max-pages ${maxPages})` : ''}`);
  }
  return listings;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (next < items.length) {
        await fn(items[next++]);
      }
    })
  );
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(1500 * attempt);
    }
  }
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatPrice(listing: OpenSeaListing) {
  const { value, decimals, currency } = listing.price.current;
  return `${formatUnits(BigInt(value), decimals)} ${currency}`;
}

async function main() {
  const args = parseArgs();
  const pool = getPostgresPool();
  const dbHost = new URL(config.database.url).host;
  const rpcHost = config.blockchain.rpcUrl ? new URL(config.blockchain.rpcUrl).host : '(none)';
  const registrar = config.blockchain.ensRegistrarAddress.toLowerCase();
  const wrapper = config.blockchain.ensNameWrapperAddress.toLowerCase();

  console.log(`Mode: ${args.apply ? 'APPLY (writes to the database)' : 'dry run (no writes)'}`);
  console.log(`Database: ${dbHost}${process.env.SKIP_DOTENV === 'true' ? '' : ' (from the root .env)'}`);
  console.log(`RPC: ${rpcHost}`);
  console.log(`Listings: ENSv2${args.includeV1 ? ' + v1' : ' only'}${args.since ? `, created since ${new Date(args.since * 1000).toISOString().slice(0, 10)}` : ''}`);

  if (!config.opensea.apiKey) throw new Error('OPENSEA_API_KEY is not set');
  if (!config.blockchain.ensv2) throw new Error('ENSv2 is not configured for this chain');

  console.log('\nReading active listings from OpenSea...');
  const all = await fetchActiveListings(args.maxPages);
  const listings = all.filter((l) => {
    const contract = l.asset!.contract.toLowerCase();
    const inScope = isEthRegistryToken(contract) || (args.includeV1 && (contract === registrar || contract === wrapper));
    return inScope && (!args.since || l.order_created_at >= args.since);
  });
  console.log(`OpenSea: ${all.length} active listings, ${listings.length} in scope`);

  const skips = new Map<string, number>();
  const skip = (reason: string) => skips.set(reason, (skips.get(reason) || 0) + 1);

  // 1. Compare with our listings table
  const rows = await pool.query(
    `SELECT id, order_hash, source, status, unfunded_reason, ens_name_id
     FROM listings WHERE order_hash = ANY($1)`,
    [listings.map((l) => l.order_hash.toLowerCase())]
  );
  const rowsByHash = new Map<string, any[]>();
  for (const row of rows.rows) {
    rowsByHash.set(row.order_hash, [...(rowsByHash.get(row.order_hash) || []), row]);
  }

  let alreadyActive = 0;
  const candidates: Candidate[] = [];
  for (const listing of listings) {
    const found = rowsByHash.get(listing.order_hash.toLowerCase()) || [];
    const base = {
      listing,
      version: (isEthRegistryToken(listing.asset!.contract) ? 2 : 1) as 1 | 2,
      tokenId: listing.asset!.identifier,
      seller: listing.protocol_data.parameters.offerer.toLowerCase(),
    };
    if (found.some((r) => r.status === 'active')) {
      alreadyActive++;
    } else if (found.length === 0) {
      candidates.push({ ...base, action: 'insert' });
    } else {
      const row = found.find((r) => r.source === 'opensea' && r.status === 'cancelled');
      if (row) {
        candidates.push({
          ...base,
          action: 'reactivate',
          rowId: row.id,
          ensNameId: row.ens_name_id,
          previous: `cancelled${row.unfunded_reason ? ` (${row.unfunded_reason})` : ''}`,
        });
      } else {
        skip(`already in our DB as ${found.map((r) => `${r.source} ${r.status}`).join(', ')}`);
      }
    }
  }
  console.log(`Already active on Grails: ${alreadyActive}; candidates: ${candidates.length}`);

  // 2. Resolve each candidate to its name, and drop orders that can't be the name's current token
  const now = Math.floor(Date.now() / 1000);
  const v1Tokens = candidates.filter((c) => c.version === 1).map((c) => c.tokenId);
  const v1Names = new Map<string, any>();
  if (v1Tokens.length > 0) {
    const result = await pool.query(
      `SELECT id, name, token_id, owner_address, expiry_date, ens_version FROM ens_names WHERE token_id = ANY($1)`,
      [v1Tokens]
    );
    for (const row of result.rows) v1Names.set(row.token_id, row);
  }

  const resolved: Candidate[] = [];
  for (const c of candidates) {
    const params = c.listing.protocol_data.parameters;
    const item = getOrderNftItem(params, 'listing');
    let ensNameId: number;
    let name: string;

    if (c.version === 2) {
      const v2 = await findEnsV2NameByTokenId(c.tokenId);
      if (!v2) { skip('v2 name not indexed'); continue; }
      if (v2.token_id !== c.tokenId) { skip('superseded v2 token ID'); continue; }
      if (checkEnsV2OrderItem(item, v2.token_id)) { skip('order item is not the current v2 token'); continue; }
      ensNameId = v2.id;
      name = v2.name;
    } else {
      const row = v1Names.get(c.tokenId);
      if (!row) { skip('unknown v1 token'); continue; }
      if (row.ens_version === 2) { skip('v1 token of a name that moved to v2'); continue; }
      if (!item || item.token.toLowerCase() !== c.listing.asset!.contract.toLowerCase()
        || BigInt(item.identifierOrCriteria).toString() !== c.tokenId) {
        skip('order item does not match the asset'); continue;
      }
      if (row.owner_address?.toLowerCase() !== c.seller) { skip('seller is not the owner in our DB'); continue; }
      if (row.expiry_date && new Date(row.expiry_date).getTime() / 1000 < now) { skip('name expired'); continue; }
      ensNameId = row.id;
      name = row.name;
    }

    if (c.action === 'reactivate' && c.ensNameId !== ensNameId) { skip('cancelled row is on a different name'); continue; }
    if (Number(params.startTime) > now) { skip('not started yet'); continue; }
    if (Number(params.endTime) < now + MIN_REMAINING_SECONDS) { skip('ends within 5 minutes'); continue; }
    if (params.offer.length !== 1 || BigInt(params.offer[0].startAmount) !== 1n) { skip('not a single-token listing'); continue; }

    resolved.push({ ...c, ensNameId, name });
  }

  // 3. One active OpenSea listing per seller per name, as the stream keeps it: skip if they
  // already have one, keep only the newest when several candidates share a name and seller
  const activeBySellerName = new Set<string>();
  if (resolved.length > 0) {
    const active = await pool.query(
      `SELECT ens_name_id, seller_address FROM listings
       WHERE status = 'active' AND source = 'opensea' AND ens_name_id = ANY($1)`,
      [[...new Set(resolved.map((c) => c.ensNameId))]]
    );
    for (const row of active.rows) activeBySellerName.add(`${row.ens_name_id}:${row.seller_address.toLowerCase()}`);
  }
  const newestFirst = [...resolved].sort((a, b) => b.listing.order_created_at - a.listing.order_created_at);
  const picked = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of newestFirst) {
    const key = `${c.ensNameId}:${c.seller}`;
    if (activeBySellerName.has(key)) { skip('seller has another active OpenSea listing on this name'); continue; }
    if (picked.has(key)) { skip('older than another candidate from the same seller'); continue; }
    picked.add(key);
    deduped.push(c);
  }

  // 4. On-chain: Seaport order state, and for v2 whether the registry allows the transfer
  console.log(`Checking ${deduped.length} listings on chain...`);
  const client = createPublicClient({ chain: viemChain, transport: http(config.blockchain.rpcUrl) });
  const planned: Candidate[] = [];
  await mapWithConcurrency(deduped, args.concurrency, async (c) => {
    const params = c.listing.protocol_data.parameters;
    const seaport = (c.listing.protocol_address || config.blockchain.seaportAddress) as `0x${string}`;
    try {
      const [status, counter] = await withRetry(() => Promise.all([
        client.readContract({ address: seaport, abi: SEAPORT_ABI, functionName: 'getOrderStatus', args: [c.listing.order_hash as `0x${string}`] }),
        client.readContract({ address: seaport, abi: SEAPORT_ABI, functionName: 'getCounter', args: [c.seller as `0x${string}`] }),
      ]));
      const [, isCancelled, totalFilled, totalSize] = status;
      if (isCancelled) { skip('cancelled on chain'); return; }
      if (totalSize > 0n && totalFilled >= totalSize) { skip('already filled'); return; }
      if (counter !== BigInt(params.counter)) { skip('seller bumped their Seaport counter'); return; }

      if (c.version === 2) {
        const operator = getOrderOperator(params.conduitKey);
        if (!operator) { skip('unknown conduit'); return; }
        const transfer = await withRetry(() => checkEnsV2Transferable({ tokenId: c.tokenId, owner: c.seller, operator }));
        if (!transfer.ok) { skip(`v2 not fillable: ${transfer.reason}`); return; }
      }
      planned.push(c);
    } catch (error: any) {
      skip('RPC error (not checked)');
      console.warn(`  RPC error for ${c.name} (${c.listing.order_hash}): ${error.shortMessage || error.message}`);
    }
  });
  planned.sort((a, b) => a.listing.order_created_at - b.listing.order_created_at);

  // 5. Report
  const inserts = planned.filter((c) => c.action === 'insert');
  const reactivations = planned.filter((c) => c.action === 'reactivate');
  console.log(`\nPlan: insert ${inserts.length}, reactivate ${reactivations.length}`);
  console.log('Skipped:');
  for (const [reason, count] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }
  const shown = args.verbose ? planned : planned.slice(0, 50);
  if (shown.length > 0) {
    console.table(shown.map((c) => ({
      action: c.action,
      v: c.version,
      name: c.name,
      price: formatPrice(c.listing),
      seller: shortAddress(c.seller),
      listed: new Date(c.listing.order_created_at * 1000).toISOString().slice(0, 16).replace('T', ' '),
      was: c.previous || '',
    })));
    if (shown.length < planned.length) console.log(`(${planned.length - shown.length} more; use --verbose or --json)`);
  }
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({
      generatedAt: new Date().toISOString(),
      database: dbHost,
      skipped: Object.fromEntries(skips),
      planned: planned.map((c) => ({
        action: c.action, version: c.version, name: c.name, ensNameId: c.ensNameId, rowId: c.rowId,
        orderHash: c.listing.order_hash, seller: c.seller, price: formatPrice(c.listing),
        createdAt: new Date(c.listing.order_created_at * 1000).toISOString(), previous: c.previous,
      })),
    }, null, 2));
    console.log(`Wrote ${args.json}`);
  }

  if (!args.apply) {
    console.log('\nDry run: nothing written. Re-run with --apply to write these changes.');
    return;
  }

  // 6. Write. Each statement re-checks that the seller still has no active listing on the
  // name, in case the stream added one since the plan was made.
  let inserted = 0;
  let reactivated = 0;
  let unchanged = 0;
  for (const c of planned) {
    const params = c.listing.protocol_data.parameters;
    const values = {
      priceWei: c.listing.price.current.value,
      currency: (params.consideration?.[0]?.token || ZERO_ADDRESS).toLowerCase(),
      orderData: JSON.stringify(c.listing.protocol_data),
      // ISO strings: created_at is a timestamp without time zone holding UTC, and a JS Date
      // would be sent in this machine's local time
      expiresAt: new Date(Number(params.endTime) * 1000).toISOString(),
      createdAt: new Date(c.listing.order_created_at * 1000).toISOString(),
    };
    try {
      if (c.action === 'insert') {
        const result = await pool.query(
          `INSERT INTO listings (
             ens_name_id, seller_address, price_wei, currency_address,
             order_hash, order_data, status, source, expires_at, created_at
           )
           SELECT $1::int, $2::varchar, $3, $4, $5, $6::jsonb, 'active', 'opensea', $7::timestamptz, $8::timestamp
           WHERE NOT EXISTS (
             SELECT 1 FROM listings
             WHERE ens_name_id = $1::int AND seller_address = $2::varchar AND status = 'active' AND source = 'opensea'
           )
           ON CONFLICT (order_hash, source) DO NOTHING
           RETURNING id`,
          [c.ensNameId, c.seller, values.priceWei, values.currency, c.listing.order_hash.toLowerCase(),
            values.orderData, values.expiresAt, values.createdAt]
        );
        if (result.rows.length > 0) inserted++; else unchanged++;
      } else {
        const result = await pool.query(
          `UPDATE listings l
           SET status = 'active', order_data = $2::jsonb, price_wei = $3, currency_address = $4,
               expires_at = $5::timestamptz, unfunded_reason = NULL, unfunded_at = NULL, updated_at = NOW()
           WHERE l.id = $1 AND l.status = 'cancelled'
             AND NOT EXISTS (
               SELECT 1 FROM listings o
               WHERE o.ens_name_id = l.ens_name_id AND o.seller_address = l.seller_address
                 AND o.status = 'active' AND o.source = 'opensea' AND o.id <> l.id
             )
           RETURNING l.id`,
          [c.rowId, values.orderData, values.priceWei, values.currency, values.expiresAt]
        );
        if (result.rows.length > 0) reactivated++; else unchanged++;
      }
    } catch (error: any) {
      unchanged++;
      console.warn(`  Failed to ${c.action} ${c.name} (${c.listing.order_hash}): ${error.message}`);
    }
  }
  console.log(`\nWrote: inserted ${inserted}, reactivated ${reactivated}, unchanged ${unchanged} (changed since the plan or failed)`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => closeAllConnections());
