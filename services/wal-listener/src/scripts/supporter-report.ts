/**
 * Supporter Report — ranks addresses by the money they put through Grails.
 *
 * Built for the anniversary NFT: everyone who signed in gets the generic NFT, and this report
 * shows who paid real money through Grails so we can size the "supporter" NFT and pick a cutoff.
 *
 * Money counted (all in USD at the time it happened):
 *   - purchases      sales.source = 'grails' (order made on Grails) or sales.filled_via = 'grails'
 *                    (foreign order filled through the Grails app), credited to the buyer
 *   - registrations  registrations with a Grails referrer code, credited to the tx sender
 *   - renewals       renewals with a Grails referrer code, credited to the tx sender
 *   - sales          the seller side of the same Grails sales. Shown, but only added to the score
 *                    with --include-sells (Grails charges sellers no fee, so they didn't spend)
 *
 * Exploit flags (from compromised_names, the 2026-09 Magic Eden drain):
 *   - exploit_recipient    got a stolen name in a $0 "sale" and isn't its original owner. Left out
 *                          of the ranking and totals; also worth dropping from the generic NFT list.
 *   - stolen_name_buyback  an original owner who paid to buy back their own stolen name. Still ranked.
 * $0 sales (the drain's zero-consideration Seaport orders) never count as purchases.
 *
 * USD values: registrations.total_cost_usd / renewals.cost_usd as stored. Sales are priced at the
 * ETH/USD rate in price_feeds at sale time; sales before price history starts (2025-10-28) use
 * the earliest feed price and are counted in `approx_priced`.
 *
 * Read-only: every query runs in a READ ONLY transaction. Reads the DB from the root .env
 * (prod) unless SKIP_DOTENV=true with DATABASE_URL set.
 *
 * Usage:
 *   cd services/wal-listener && npm run supporter-report -- [options]
 *   (or: npm run build && node dist/wal-listener/src/scripts/supporter-report.js [options])
 *
 * Options:
 *   --since YYYY-MM-DD   Only count money from this date on (default: all time)
 *   --until YYYY-MM-DD   Snapshot cutoff, exclusive (default: now)
 *   --include-sells      Add seller proceeds to the score
 *   --no-names           Skip primary-name lookups
 *   --names-api URL      enstate-compatible API for primary names (default: hotbox ensv2 mainnet API)
 *   --output-dir DIR     Where to write files (default: ./supporter-report-<date>)
 *
 * Outputs:
 *   accounts.csv   every signed-in user plus every non-user who paid through Grails, ranked
 *   summary.json   totals, threshold table and top-N table (also printed to the console)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getPostgresPool, closeAllConnections, config, ENS_REFERRER_CODES } from '../../../shared/src';

const GRAILS_REFERRERS = Object.entries(ENS_REFERRER_CODES)
  .filter(([, source]) => source === 'grails')
  .map(([code]) => code.toLowerCase());

const THRESHOLDS_USD = [1, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const TOP_N = [10, 25, 50, 100, 250, 500, 1000];
const DEFAULT_NAMES_API = 'https://mainnet-api-prod-ensv2.on.hotbox.wtf';

interface Options {
  since: Date | null;
  until: Date;
  includeSells: boolean;
  resolveNames: boolean;
  namesApi: string;
  outputDir: string;
}

interface Contribution {
  address: string;
  purchases_usd: number;
  purchases: number;
  registrations_usd: number;
  registrations: number;
  renewals_usd: number;
  renewals: number;
  sales_usd: number;
  sales: number;
  approx_priced: number;
  unpriced: number;
  first_activity: Date | null;
  last_activity: Date | null;
  exploit_recipient: boolean;
  stolen_name_buybacks: number;
}

interface UserRow {
  address: string;
  created_at: Date | null;
  last_sign_in: Date | null;
}

interface Account extends Contribution {
  flags: string;
  primary_name: string | null;
  is_user: boolean;
  user_created_at: Date | null;
  last_sign_in: Date | null;
  score_usd: number;
  rank: number | null;
  user_rank: number | null;
  pct_of_total: number;
  cumulative_pct: number;
}

function parseDate(flag: string, value: string | undefined): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value) || isNaN(Date.parse(value))) {
    throw new Error(`${flag} needs a date like 2025-11-01, got: ${value}`);
  }
  return new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    since: null,
    until: new Date(),
    includeSells: false,
    resolveNames: true,
    namesApi: DEFAULT_NAMES_API,
    outputDir: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--since': opts.since = parseDate(arg, argv[++i]); break;
      case '--until': opts.until = parseDate(arg, argv[++i]); break;
      case '--include-sells': opts.includeSells = true; break;
      case '--no-names': opts.resolveNames = false; break;
      case '--names-api': opts.namesApi = argv[++i].replace(/\/+$/, ''); break;
      case '--output-dir': opts.outputDir = argv[++i]; break;
      case '--help':
      case '-h':
        console.log('See the header of supporter-report.ts for options.');
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.outputDir) {
    opts.outputDir = path.resolve(process.cwd(), `supporter-report-${opts.until.toISOString().slice(0, 10)}`);
  }
  return opts;
}

const CONTRIBUTIONS_SQL = `
WITH first_px AS (
  SELECT price FROM price_feeds
  WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
  ORDER BY timestamp ASC LIMIT 1
),
grails_sales AS (
  SELECT lower(buyer_address) AS buyer,
         lower(seller_address) AS seller,
         sale_date AT TIME ZONE 'UTC' AS at,
         calculate_usd_value(
           sale_price_wei,
           COALESCE(currency_address, '0x0000000000000000000000000000000000000000'),
           COALESCE(eth_usd_price_at(sale_date), (SELECT price FROM first_px))
         ) AS usd,
         (eth_usd_price_at(sale_date) IS NULL) AS approx
  FROM sales
  WHERE (source = 'grails' OR filled_via = 'grails')
    AND lower(buyer_address) <> lower(seller_address)
    AND sale_price_wei <> '0'
    AND ($1::timestamptz IS NULL OR sale_date >= $1::timestamptz)
    AND sale_date < $2::timestamptz
),
events AS (
  SELECT buyer AS address, 'purchase' AS kind, usd, approx, at FROM grails_sales
  UNION ALL
  SELECT seller, 'sale', usd, approx, at FROM grails_sales
  UNION ALL
  SELECT lower(registrant_address), 'registration', total_cost_usd, false, registration_date
  FROM registrations
  WHERE lower(referrer) = ANY($3::text[])
    AND ($1::timestamptz IS NULL OR registration_date >= $1::timestamptz)
    AND registration_date < $2::timestamptz
  UNION ALL
  SELECT lower(renewer_address), 'renewal', cost_usd, false, renewal_date
  FROM renewals
  WHERE lower(referrer) = ANY($3::text[])
    AND ($1::timestamptz IS NULL OR renewal_date >= $1::timestamptz)
    AND renewal_date < $2::timestamptz
),
-- Received a stolen name for $0 and isn't the original owner (or one of its recovery wallets).
exploit_recipients AS (
  SELECT DISTINCT lower(s.buyer_address) AS address
  FROM sales s
  JOIN compromised_names cn ON cn.ens_name_id = s.ens_name_id
  WHERE s.sale_price_wei = '0'
    AND lower(s.buyer_address) <> cn.original_owner
    AND NOT (lower(s.buyer_address) = ANY(cn.allowed_addresses))
),
-- Original owners who paid to get their stolen name back.
buybacks AS (
  SELECT lower(s.buyer_address) AS address, COUNT(*)::int AS n
  FROM sales s
  JOIN compromised_names cn ON cn.ens_name_id = s.ens_name_id
  WHERE (s.source = 'grails' OR s.filled_via = 'grails')
    AND s.sale_price_wei <> '0'
    AND (lower(s.buyer_address) = cn.original_owner OR lower(s.buyer_address) = ANY(cn.allowed_addresses))
  GROUP BY 1
),
per_address AS (
SELECT address,
  COALESCE(SUM(usd) FILTER (WHERE kind = 'purchase'), 0)::float8     AS purchases_usd,
  COUNT(*) FILTER (WHERE kind = 'purchase')::int                      AS purchases,
  COALESCE(SUM(usd) FILTER (WHERE kind = 'registration'), 0)::float8 AS registrations_usd,
  COUNT(*) FILTER (WHERE kind = 'registration')::int                  AS registrations,
  COALESCE(SUM(usd) FILTER (WHERE kind = 'renewal'), 0)::float8      AS renewals_usd,
  COUNT(*) FILTER (WHERE kind = 'renewal')::int                       AS renewals,
  COALESCE(SUM(usd) FILTER (WHERE kind = 'sale'), 0)::float8         AS sales_usd,
  COUNT(*) FILTER (WHERE kind = 'sale')::int                          AS sales,
  COUNT(*) FILTER (WHERE approx AND kind <> 'sale')::int              AS approx_priced,
  COUNT(*) FILTER (WHERE usd IS NULL)::int                            AS unpriced,
  MIN(at)                                                             AS first_activity,
  MAX(at)                                                             AS last_activity
FROM events
GROUP BY address
)
SELECT p.*,
  (er.address IS NOT NULL) AS exploit_recipient,
  COALESCE(b.n, 0)         AS stolen_name_buybacks
FROM per_address p
LEFT JOIN exploit_recipients er ON er.address = p.address
LEFT JOIN buybacks b ON b.address = p.address
UNION ALL
-- Exploit recipients with no Grails money still need their flag (e.g. signed-in users).
SELECT er.address, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, true, 0
FROM exploit_recipients er
WHERE NOT EXISTS (SELECT 1 FROM per_address p WHERE p.address = er.address)
`;

// Signed-in accounts only: is_stub rows are chat placeholders that never did SIWE.
// users.* and sales.sale_date are `timestamp without time zone` holding UTC; AT TIME ZONE 'UTC'
// turns them into timestamptz so node-pg doesn't read them as local time.
const USERS_SQL = `
SELECT lower(address) AS address,
       created_at AT TIME ZONE 'UTC' AS created_at,
       last_sign_in AT TIME ZONE 'UTC' AS last_sign_in
FROM users
WHERE last_sign_in IS NOT NULL
  AND COALESCE(is_stub, false) = false
  AND created_at < $1::timestamptz
`;

async function loadData(opts: Options): Promise<{ contributions: Contribution[]; users: UserRow[] }> {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL TIME ZONE 'UTC'`);
    await client.query(`SET LOCAL statement_timeout = '300s'`);
    const contributions = await client.query<Contribution>(CONTRIBUTIONS_SQL, [
      opts.since?.toISOString() ?? null,
      opts.until.toISOString(),
      GRAILS_REFERRERS,
    ]);
    const users = await client.query<UserRow>(USERS_SQL, [opts.until.toISOString()]);
    await client.query('COMMIT');
    return { contributions: contributions.rows, users: users.rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Primary ENS names from an enstate-compatible API (GET /bulk/a?addresses[]=...). */
async function resolvePrimaryNames(addresses: string[], api: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const CHUNK = 50;
  let failedChunks = 0;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const qs = chunk.map((a) => `addresses[]=${a}`).join('&');
    try {
      const res = await fetch(`${api}/bulk/a?${qs}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { response?: Array<{ type: string; name?: string; address?: string }> };
      (body.response ?? []).forEach((r, j) => {
        const address = (r.address ?? chunk[j]).toLowerCase();
        if (r.type === 'success' && r.name) names.set(address, r.name);
      });
    } catch (err: any) {
      failedChunks++;
      if (failedChunks === 1) console.warn(`\n  primary-name lookup failed (${err.message}); continuing`);
    }
    process.stdout.write(`\r  primary names: ${Math.min(i + CHUNK, addresses.length)}/${addresses.length} (${names.size} found)`);
  }
  process.stdout.write('\n');
  if (failedChunks) console.warn(`  WARNING: ${failedChunks} of ${Math.ceil(addresses.length / CHUNK)} name batches failed`);
  return names;
}

function buildAccounts(
  contributions: Contribution[],
  users: UserRow[],
  names: Map<string, string>,
  includeSells: boolean,
): Account[] {
  const userMap = new Map(users.map((u) => [u.address, u]));
  const byAddress = new Map<string, Account>();
  const empty = (address: string): Contribution => ({
    address, purchases_usd: 0, purchases: 0, registrations_usd: 0, registrations: 0,
    renewals_usd: 0, renewals: 0, sales_usd: 0, sales: 0, approx_priced: 0, unpriced: 0,
    first_activity: null, last_activity: null, exploit_recipient: false, stolen_name_buybacks: 0,
  });

  for (const c of [...contributions, ...users.map((u) => empty(u.address))]) {
    if (byAddress.has(c.address)) continue;
    const user = userMap.get(c.address);
    const score = c.exploit_recipient
      ? 0
      : c.purchases_usd + c.registrations_usd + c.renewals_usd + (includeSells ? c.sales_usd : 0);
    const flags = [
      c.exploit_recipient ? 'exploit_recipient' : '',
      c.stolen_name_buybacks ? 'stolen_name_buyback' : '',
    ].filter(Boolean).join(';');
    byAddress.set(c.address, {
      ...c,
      flags,
      primary_name: names.get(c.address) ?? null,
      is_user: !!user,
      user_created_at: user?.created_at ?? null,
      last_sign_in: user?.last_sign_in ?? null,
      score_usd: Math.round(score * 100) / 100,
      rank: null,
      user_rank: null,
      pct_of_total: 0,
      cumulative_pct: 0,
    });
  }

  const accounts = [...byAddress.values()].sort(
    (a, b) =>
      b.score_usd - a.score_usd ||
      b.sales_usd - a.sales_usd ||
      (b.last_sign_in?.getTime() ?? 0) - (a.last_sign_in?.getTime() ?? 0),
  );
  const total = accounts.reduce((s, a) => s + a.score_usd, 0);
  let running = 0;
  let rank = 0;
  let userRank = 0;
  for (const a of accounts) {
    if (a.score_usd <= 0) continue;
    running += a.score_usd;
    a.rank = ++rank;
    if (a.is_user) a.user_rank = ++userRank;
    a.pct_of_total = total ? (100 * a.score_usd) / total : 0;
    a.cumulative_pct = total ? (100 * running) / total : 0;
  }
  return accounts;
}

function summarize(accounts: Account[], opts: Options) {
  const payers = accounts.filter((a) => a.score_usd > 0);
  const userPayers = payers.filter((a) => a.is_user);
  const sum = (xs: Account[], f: (a: Account) => number) => xs.reduce((s, a) => s + f(a), 0);
  const total = sum(payers, (a) => a.score_usd);
  const clean = accounts.filter((a) => !a.exploit_recipient);
  const round = (n: number) => Math.round(n * 100) / 100;

  const thresholds = THRESHOLDS_USD.map((t) => {
    const all = payers.filter((a) => a.score_usd >= t);
    const users = all.filter((a) => a.is_user);
    return {
      min_usd: t,
      addresses: all.length,
      signed_in_users: users.length,
      non_users: all.length - users.length,
      pct_of_total: round((100 * sum(all, (a) => a.score_usd)) / total),
    };
  });

  const topN = TOP_N.filter((n) => n <= payers.length || n === TOP_N[0]).map((n) => {
    const top = payers.slice(0, n);
    return {
      top: n,
      min_score_usd: top.length ? top[top.length - 1].score_usd : 0,
      signed_in_users: top.filter((a) => a.is_user).length,
      pct_of_total: round((100 * sum(top, (a) => a.score_usd)) / total),
    };
  });

  return {
    generated_at: new Date().toISOString(),
    window: { since: opts.since?.toISOString() ?? null, until: opts.until.toISOString() },
    scoring: opts.includeSells
      ? 'purchases + registrations + renewals + seller proceeds'
      : 'purchases + registrations + renewals (seller proceeds shown, not scored)',
    grails_referrer_codes: GRAILS_REFERRERS,
    accounts: {
      signed_in_users: accounts.filter((a) => a.is_user).length,
      paying_addresses: payers.length,
      paying_signed_in_users: userPayers.length,
      paying_non_users: payers.length - userPayers.length,
      sellers_only: accounts.filter((a) => a.score_usd <= 0 && a.sales > 0 && !a.exploit_recipient).length,
      exploit_recipients: accounts.filter((a) => a.exploit_recipient).length,
      exploit_recipients_signed_in: accounts.filter((a) => a.exploit_recipient && a.is_user).length,
      stolen_name_buyback_payers: payers.filter((a) => a.stolen_name_buybacks > 0).length,
    },
    // Exploit recipients are left out of every total below.
    totals_usd: {
      score: round(total),
      purchases: round(sum(clean, (a) => a.purchases_usd)),
      registrations: round(sum(clean, (a) => a.registrations_usd)),
      renewals: round(sum(clean, (a) => a.renewals_usd)),
      seller_proceeds: round(sum(clean, (a) => a.sales_usd)),
    },
    counts: {
      purchases: sum(clean, (a) => a.purchases),
      registrations: sum(clean, (a) => a.registrations),
      renewals: sum(clean, (a) => a.renewals),
      approx_priced: sum(clean, (a) => a.approx_priced),
      unpriced: sum(clean, (a) => a.unpriced),
    },
    thresholds,
    top_n: topN,
  };
}

const CSV_COLUMNS: (keyof Account)[] = [
  'rank', 'user_rank', 'address', 'primary_name', 'is_user', 'flags', 'score_usd', 'pct_of_total', 'cumulative_pct',
  'purchases_usd', 'purchases', 'registrations_usd', 'registrations', 'renewals_usd', 'renewals',
  'sales_usd', 'sales', 'first_activity', 'last_activity', 'user_created_at', 'last_sign_in',
  'approx_priced', 'unpriced',
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, accounts: Account[]) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const a of accounts) lines.push(CSV_COLUMNS.map((c) => csvCell(a[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function printSummary(summary: ReturnType<typeof summarize>, accounts: Account[]) {
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  console.log('\n=== Grails supporter report ===');
  console.log(`Window: ${summary.window.since ?? 'all time'} → ${summary.window.until}`);
  console.log(`Score: ${summary.scoring}`);
  console.log(`Signed-in users: ${summary.accounts.signed_in_users}`);
  console.log(
    `Paying addresses: ${summary.accounts.paying_addresses} ` +
      `(${summary.accounts.paying_signed_in_users} signed-in users, ${summary.accounts.paying_non_users} never signed in)`,
  );
  console.log(
    `Totals: score ${usd(summary.totals_usd.score)} | purchases ${usd(summary.totals_usd.purchases)} | ` +
      `registrations ${usd(summary.totals_usd.registrations)} | renewals ${usd(summary.totals_usd.renewals)} | ` +
      `seller proceeds ${usd(summary.totals_usd.seller_proceeds)}`,
  );
  console.log(
    `Exploit recipients (unranked): ${summary.accounts.exploit_recipients} ` +
      `(${summary.accounts.exploit_recipients_signed_in} signed in) | ` +
      `stolen-name buyback payers (ranked): ${summary.accounts.stolen_name_buyback_payers}`,
  );
  if (summary.counts.unpriced) console.log(`WARNING: ${summary.counts.unpriced} events had no USD value and count as $0`);

  console.log('\nHow many supporter NFTs at each cutoff:');
  console.table(summary.thresholds.map((t) => ({
    'min spend': usd(t.min_usd), addresses: t.addresses, 'signed-in': t.signed_in_users,
    'never signed in': t.non_users, '% of money': `${t.pct_of_total}%`,
  })));

  console.log('Top-N share of money:');
  console.table(summary.top_n.map((t) => ({
    top: t.top, 'cutoff score': usd(t.min_score_usd), 'signed-in': t.signed_in_users, '% of money': `${t.pct_of_total}%`,
  })));

  console.log('Top 15:');
  console.table(accounts.slice(0, 15).map((a) => ({
    rank: a.rank, who: a.primary_name ?? a.address, user: a.is_user, score: usd(a.score_usd),
    '%': a.pct_of_total.toFixed(1), buys: usd(a.purchases_usd), regs: usd(a.registrations_usd),
    renews: usd(a.renewals_usd),
  })));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbHost = (() => { try { return new URL(config.database.url).hostname; } catch { return '?'; } })();
  console.log(`Reading from database host: ${dbHost} (read-only)`);
  console.log(`Grails referrer codes: ${GRAILS_REFERRERS.join(', ')}`);

  const { contributions, users } = await loadData(opts);
  console.log(`Loaded ${contributions.length} contributing addresses and ${users.length} signed-in users`);

  let names = new Map<string, string>();
  if (opts.resolveNames) {
    const toResolve = contributions
      .filter((c) => c.purchases + c.registrations + c.renewals + c.sales > 0)
      .map((c) => c.address);
    console.log(`Looking up primary names via ${opts.namesApi}`);
    names = await resolvePrimaryNames(toResolve, opts.namesApi);
  }

  const accounts = buildAccounts(contributions, users, names, opts.includeSells);
  const summary = summarize(accounts, opts);

  fs.mkdirSync(opts.outputDir, { recursive: true });
  writeCsv(path.join(opts.outputDir, 'accounts.csv'), accounts);
  fs.writeFileSync(path.join(opts.outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  printSummary(summary, accounts.filter((a) => a.rank !== null));
  console.log(`\nWrote ${accounts.length} rows to ${path.join(opts.outputDir, 'accounts.csv')}`);
  console.log(`Wrote ${path.join(opts.outputDir, 'summary.json')}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeAllConnections());
