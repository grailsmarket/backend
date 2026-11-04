/**
 * Read-only check: for .eth names we currently label grace or premium, compare our phase
 * (shared/utils/expiry-phase.ts) with what the ENSv2 contracts say right now.
 *
 * Per name it reads ETHRegistry.getState(labelhash) and ETHRegistrar.isAvailable(label),
 * and for available names ETHRegistrar.getRegisterPrice(label, 1 year, USDC) to get the
 * live premium. Unmigrated v1 names that were never reserved on v2 have expiry 0 there,
 * which the registrar treats as "never registered": available, zero premium.
 *
 * Writes nothing. Prints a summary, mismatches, and a CSV in the scratch dir if given.
 *
 * Usage (from services/wal-listener):
 *   npm run build && node dist/wal-listener/src/scripts/check-v2-premium-status.js [--csv out.csv]
 */

import * as fs from 'fs';
import { createPublicClient, http, keccak256, toBytes, type Address } from 'viem';
import { config, getPostgresPool, closeAllConnections, getExpiryPhase } from '../../../shared/src';

// Mainnet fallback when the ensv2 preset isn't configured (verified against
// docs.ens.domains/learn/deployments + contracts-v2 deployments/mainnet, 2026-10-22).
const MAINNET_V2 = {
  ethRegistryAddress: '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2',
  ethRegistrarAddress: '0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81',
};

const STATUS = ['AVAILABLE', 'RESERVED', 'REGISTERED'] as const;
const ONE_YEAR = 365n * 24n * 60n * 60n;
const BATCH = 500;

const registryAbi = [
  {
    type: 'function', name: 'getState', stateMutability: 'view',
    inputs: [{ name: 'anyId', type: 'uint256' }],
    outputs: [{
      name: 'state', type: 'tuple', components: [
        { name: 'status', type: 'uint8' },
        { name: 'expiry', type: 'uint64' },
        { name: 'latestOwner', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'resource', type: 'uint256' },
      ],
    }],
  },
] as const;

const registrarAbi = [
  {
    type: 'function', name: 'isAvailable', stateMutability: 'view',
    inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'getRegisterPrice', stateMutability: 'view',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'duration', type: 'uint64' },
      { name: 'paymentToken', type: 'address' },
    ],
    outputs: [{ name: 'base', type: 'uint256' }, { name: 'premium', type: 'uint256' }],
  },
  {
    type: 'function', name: 'GRACE_PERIOD', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint64' }],
  },
] as const;

function host(url: string | undefined): string {
  try { return url ? new URL(url).hostname : '(not set)'; } catch { return '(unparseable)'; }
}

async function main() {
  const csvIdx = process.argv.indexOf('--csv');
  const csvPath = csvIdx > -1 ? process.argv[csvIdx + 1] : null;

  const v2 = config.blockchain.ensv2 ?? (config.blockchain.chainId === 1 ? MAINNET_V2 : null);
  if (!v2) throw new Error(`No ENSv2 addresses for chain ${config.blockchain.chainId}`);
  const registry = v2.ethRegistryAddress as Address;
  const registrar = v2.ethRegistrarAddress as Address;
  const usdc = config.blockchain.usdcAddress as Address;

  console.log(`Chain:     ${config.blockchain.chainId}`);
  console.log(`Database:  ${host(config.database.url)} (read-only)`);
  console.log(`RPC:       ${host(config.blockchain.rpcUrl)}`);
  console.log(`Registry:  ${registry}`);
  console.log(`Registrar: ${registrar}\n`);

  const client = createPublicClient({ transport: http(config.blockchain.rpcUrl) });
  const grace = await client.readContract({ address: registrar, abi: registrarAbi, functionName: 'GRACE_PERIOD' });
  console.log(`Registrar GRACE_PERIOD: ${Number(grace) / 86400} days\n`);

  // Every 2LD .eth name expired within the last 111 days: covers grace + premium for both versions.
  const pool = getPostgresPool();
  const { rows } = await pool.query<{ name: string; expiry_date: Date; ens_version: number }>(
    `SELECT name, expiry_date, ens_version
       FROM ens_names
      WHERE name LIKE '%.eth' AND name NOT LIKE '%.%.eth'
        AND expiry_date <= NOW() AND expiry_date > NOW() - INTERVAL '111 days'
      ORDER BY expiry_date`
  );
  console.log(`Names expired in the last 111 days: ${rows.length}`);

  type Row = {
    name: string; version: number; dbExpiry: string; ourPhase: string;
    chainStatus: string; chainExpiry: string; available: boolean | null; premiumUsdc: string; chainPhase: string;
  };
  const out: Row[] = [];

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const labels = batch.map((r) => r.name.slice(0, -4));
    const states = await client.multicall({
      allowFailure: true, multicallAddress: config.blockchain.multicall3Address as Address,
      contracts: labels.map((l) => ({
        address: registry, abi: registryAbi, functionName: 'getState' as const,
        args: [BigInt(keccak256(toBytes(l)))],
      })),
    });
    const avail = await client.multicall({
      allowFailure: true, multicallAddress: config.blockchain.multicall3Address as Address,
      contracts: labels.map((l) => ({
        address: registrar, abi: registrarAbi, functionName: 'isAvailable' as const, args: [l],
      })),
    });
    const prices = await client.multicall({
      allowFailure: true, multicallAddress: config.blockchain.multicall3Address as Address,
      contracts: labels.map((l) => ({
        address: registrar, abi: registrarAbi, functionName: 'getRegisterPrice' as const,
        args: [l, ONE_YEAR, usdc],
      })),
    });

    batch.forEach((r, j) => {
      const st = states[j].status === 'success' ? (states[j].result as any) : null;
      const isAvail = avail[j].status === 'success' ? (avail[j].result as boolean) : null;
      const price = prices[j].status === 'success' ? (prices[j].result as readonly [bigint, bigint]) : null;
      const premium = price ? price[1] : null;

      let chainPhase = 'error';
      if (st && isAvail !== null) {
        if (!isAvail) chainPhase = Number(st.status) === 0 ? 'grace' : STATUS[Number(st.status)].toLowerCase();
        else if (premium === null) chainPhase = 'available?(price reverted)';
        else chainPhase = premium > 0n ? 'premium' : 'available';
      }

      out.push({
        name: r.name,
        version: r.ens_version,
        dbExpiry: r.expiry_date.toISOString(),
        ourPhase: getExpiryPhase(r.expiry_date, r.ens_version) ?? 'none',
        chainStatus: st ? STATUS[Number(st.status)] : 'error',
        chainExpiry: st ? (st.expiry === 0n ? '0 (no v2 entry)' : new Date(Number(st.expiry) * 1000).toISOString()) : 'error',
        available: isAvail,
        premiumUsdc: premium === null ? '' : (Number(premium) / 1e6).toFixed(2),
        chainPhase,
      });
    });
    process.stdout.write(`  checked ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`);
  }
  console.log('');

  // Summary: our phase vs the chain's phase, split by version
  const tally = new Map<string, number>();
  for (const r of out) {
    const k = `v${r.version}  ours=${r.ourPhase.padEnd(9)} chain=${r.chainPhase}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  console.log('\nOur phase vs chain:');
  for (const [k, n] of [...tally].sort()) console.log(`  ${String(n).padStart(6)}  ${k}`);

  // "registered"/"reserved" on chain means the name isn't available; we'd call it grace
  const norm = (p: string) => (p === 'reserved' || p === 'registered' ? 'grace' : p);
  const mismatches = out.filter((r) => norm(r.chainPhase) !== r.ourPhase);
  console.log(`\nMismatches: ${mismatches.length}`);
  for (const r of mismatches.slice(0, 25)) {
    console.log(`  ${r.name}  v${r.version}  expiry ${r.dbExpiry}  ours=${r.ourPhase}  chain=${r.chainPhase} (${r.chainStatus}, v2 expiry ${r.chainExpiry}, premium ${r.premiumUsdc} USDC)`);
  }
  if (mismatches.length > 25) console.log(`  ...and ${mismatches.length - 25} more`);

  if (csvPath) {
    const header = Object.keys(out[0] ?? {}).join(',');
    fs.writeFileSync(csvPath, [header, ...out.map((r) => Object.values(r).join(','))].join('\n'));
    console.log(`\nWrote ${out.length} rows to ${csvPath}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => closeAllConnections());
