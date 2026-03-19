/**
 * Check unclaimed ENS old registrar deposits for users
 *
 * ENS originally used a Vickrey auction system (2017–2019) where users locked ETH
 * in individual Deed contracts via the old registrar. When ENS switched to the
 * spent-fee model, many users never reclaimed their locked deposits.
 *
 * This script checks every user address for unclaimed deed deposits and outputs
 * a report showing who has reclaimable ETH and how much.
 *
 * Approach: Subgraph-first with Etherscan fallback, then on-chain balance verification.
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node dist/wal-listener/src/scripts/check-unclaimed-deposits.js [options]
 *
 * Options:
 *   --limit <n>       Max users to check (default: all)
 *   --offset <n>      Start from this offset (default: 0)
 *   --batch-size <n>  Addresses per subgraph query (default: 50)
 *   --verbose         Show detailed output per address
 */

import { getPostgresPool, config } from '../../../shared/src';
import { createPublicClient, http, formatEther, parseAbi, keccak256, toBytes } from 'viem';
import { mainnet } from 'viem/chains';
import * as fs from 'fs';

const OLD_REGISTRAR = '0x6090a6e47849629b7245dfa1ca21d94cd15878ef';
const RECLAIM_SUBGRAPH_ID = '8zhr2kf1ka6B4sLmuhEzo8gQ7FTjay6DXQrefmRtNb8W';

// Etherscan fallback constants
// Computed at startup via verifyTopic0(), but hardcoded for Etherscan fallback
const HASH_REGISTERED_TOPIC0 = keccak256(toBytes('HashRegistered(bytes32,address,uint256,uint256)'));
const FROM_BLOCK = 3648534;
const TO_BLOCK = 9380471;

const registrarAbi = parseAbi([
  'function entries(bytes32 _hash) view returns (uint8, address, uint256, uint256, uint256)',
]);

interface SubgraphDeed {
  id: string; // deed contract address
  value: string; // locked ETH value in wei
}

interface UnclaimedDeposit {
  deedAddress: string;
  balance: string; // ETH
  balanceWei: bigint;
}

interface UserResult {
  address: string;
  deeds: UnclaimedDeposit[];
  totalUnclaimedWei: bigint;
  totalUnclaimedEth: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function querySubgraphForDeeds(
  addresses: string[],
): Promise<Map<string, SubgraphDeed[]>> {
  const apiKey = config.theGraph.apiKey;
  if (!apiKey) {
    throw new Error('THE_GRAPH_API_KEY not configured');
  }

  const url = `https://gateway-arbitrum.network.thegraph.com/api/${apiKey}/subgraphs/id/${RECLAIM_SUBGRAPH_ID}`;

  const query = `
    query GetDeeds($addresses: [String!]!) {
      accounts(where: { id_in: $addresses }) {
        id
        deeds(first: 500) {
          id
          value
        }
      }
    }
  `;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { addresses: addresses.map((a) => a.toLowerCase()) },
    }),
  });

  if (!response.ok) {
    throw new Error(`Subgraph API error: ${response.status} ${response.statusText}`);
  }

  const result: any = await response.json();

  if (result.errors) {
    throw new Error(`Subgraph GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  const deedsMap = new Map<string, SubgraphDeed[]>();

  if (result.data?.accounts) {
    for (const account of result.data.accounts) {
      if (account.deeds && account.deeds.length > 0) {
        deedsMap.set(account.id.toLowerCase(), account.deeds);
      }
    }
  }

  return deedsMap;
}

async function queryEtherscanForDeeds(address: string): Promise<string[]> {
  const apiKey = config.etherscan.apiKey;
  const baseUrl = config.etherscan.baseUrl;
  const paddedAddress = `0x000000000000000000000000${address.slice(2).toLowerCase()}`;

  const url = `${baseUrl}?chainid=1&module=logs&action=getLogs&address=${OLD_REGISTRAR}&topic0=${HASH_REGISTERED_TOPIC0}&topic2=${paddedAddress}&topic0_2_opr=and&fromBlock=${FROM_BLOCK}&toBlock=${TO_BLOCK}${apiKey ? `&apikey=${apiKey}` : ''}`;

  const response = await fetch(url);
  const data: any = await response.json();

  if (data.status !== '1' || !Array.isArray(data.result)) {
    return [];
  }

  // Extract nameHashes from topics[1] for each event
  const nameHashes: string[] = data.result.map((log: any) => log.topics[1]);
  return nameHashes;
}

async function getDeedAddressFromRegistrar(
  client: ReturnType<typeof createPublicClient>,
  nameHash: string,
): Promise<string | null> {
  try {
    const result = await client.readContract({
      address: OLD_REGISTRAR as `0x${string}`,
      abi: registrarAbi,
      functionName: 'entries',
      args: [nameHash as `0x${string}`],
    });
    // result: [mode, deedAddress, registrationDate, value, highestBid]
    const deedAddress = (result as unknown as any[])[1] as string;
    if (
      deedAddress &&
      deedAddress !== '0x0000000000000000000000000000000000000000'
    ) {
      return deedAddress;
    }
    return null;
  } catch {
    return null;
  }
}

async function checkUnclaimedDeposits(options: {
  limit?: number;
  offset?: number;
  batchSize?: number;
  verbose?: boolean;
}) {
  const pool = getPostgresPool();
  const limit = options.limit;
  const offset = options.offset || 0;
  const batchSize = options.batchSize || 50;
  const verbose = options.verbose || false;

  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  try {
    console.log('\n=== Unclaimed ENS Deposit Check ===\n');
    console.log(`Old Registrar: ${OLD_REGISTRAR}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit || 'all'}`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`Verbose: ${verbose}\n`);

    // Fetch user addresses
    console.log('Fetching user addresses...\n');
    const query = limit
      ? 'SELECT address FROM users ORDER BY id LIMIT $1 OFFSET $2'
      : 'SELECT address FROM users ORDER BY id OFFSET $1';
    const params = limit ? [limit, offset] : [offset];
    const result = await pool.query(query, params);
    const addresses: string[] = result.rows.map((r: any) => r.address);

    console.log(`Found ${addresses.length} users to check\n`);

    if (addresses.length === 0) {
      console.log('No users to process!');
      return;
    }

    // Process in batches
    let usersChecked = 0;
    let usersWithDeeds = 0;
    let totalDeedsFound = 0;
    let totalUnclaimedWei = 0n;
    const results: UserResult[] = [];
    let useEtherscanFallback = false;

    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(addresses.length / batchSize);

      console.log(
        `Processing batch ${batchNum}/${totalBatches} (${batch.length} addresses)...`,
      );

      // Map of address -> deed addresses to verify
      let addressDeedMap = new Map<string, string[]>();

      if (!useEtherscanFallback) {
        // Try subgraph first
        try {
          const subgraphResults = await querySubgraphForDeeds(batch);

          for (const [addr, deeds] of subgraphResults.entries()) {
            addressDeedMap.set(
              addr,
              deeds.map((d) => d.id),
            );
          }

          if (verbose) {
            console.log(
              `  Subgraph returned deeds for ${subgraphResults.size}/${batch.length} addresses`,
            );
          }
        } catch (error: any) {
          console.warn(`  Subgraph error: ${error.message}`);
          console.warn('  Falling back to Etherscan for remaining addresses...\n');
          useEtherscanFallback = true;
        }
      }

      if (useEtherscanFallback) {
        // Etherscan fallback: query per address
        for (const addr of batch) {
          try {
            const nameHashes = await queryEtherscanForDeeds(addr);
            if (nameHashes.length > 0) {
              const deedAddresses: string[] = [];
              for (const nameHash of nameHashes) {
                const deedAddr = await getDeedAddressFromRegistrar(
                  client,
                  nameHash,
                );
                if (deedAddr) {
                  deedAddresses.push(deedAddr);
                }
                await sleep(100); // Rate limit RPC
              }
              if (deedAddresses.length > 0) {
                addressDeedMap.set(addr.toLowerCase(), deedAddresses);
              }
            }
            await sleep(200); // Rate limit Etherscan
          } catch (error: any) {
            // Retry up to 3 times with exponential backoff
            let retried = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              await sleep(1000 * Math.pow(2, attempt));
              try {
                const nameHashes = await queryEtherscanForDeeds(addr);
                if (nameHashes.length > 0) {
                  const deedAddresses: string[] = [];
                  for (const nameHash of nameHashes) {
                    const deedAddr = await getDeedAddressFromRegistrar(
                      client,
                      nameHash,
                    );
                    if (deedAddr) {
                      deedAddresses.push(deedAddr);
                    }
                    await sleep(100);
                  }
                  if (deedAddresses.length > 0) {
                    addressDeedMap.set(addr.toLowerCase(), deedAddresses);
                  }
                }
                retried = true;
                break;
              } catch {
                // Continue retrying
              }
            }
            if (!retried) {
              console.warn(
                `  Failed to query Etherscan for ${addr} after 3 retries`,
              );
            }
          }
        }
      }

      // For each address with deeds, verify on-chain balance
      for (const addr of batch) {
        usersChecked++;
        const deedAddresses = addressDeedMap.get(addr.toLowerCase());

        if (!deedAddresses || deedAddresses.length === 0) {
          if (verbose) {
            console.log(`  ${addr}: no deeds`);
          }
          continue;
        }

        const unclaimed: UnclaimedDeposit[] = [];

        for (const deedAddr of deedAddresses) {
          try {
            const balance = await client.getBalance({
              address: deedAddr as `0x${string}`,
            });

            if (balance > 0n) {
              unclaimed.push({
                deedAddress: deedAddr,
                balance: formatEther(balance),
                balanceWei: balance,
              });
            }
          } catch (error: any) {
            if (verbose) {
              console.warn(
                `  Error checking balance for deed ${deedAddr}: ${error.message}`,
              );
            }
            // Retry once after delay
            await sleep(5000);
            try {
              const balance = await client.getBalance({
                address: deedAddr as `0x${string}`,
              });
              if (balance > 0n) {
                unclaimed.push({
                  deedAddress: deedAddr,
                  balance: formatEther(balance),
                  balanceWei: balance,
                });
              }
            } catch {
              console.warn(
                `  Failed to check balance for deed ${deedAddr} (skipping)`,
              );
            }
          }
          await sleep(50); // Small delay between RPC calls
        }

        if (unclaimed.length > 0) {
          const userTotalWei = unclaimed.reduce(
            (sum, d) => sum + d.balanceWei,
            0n,
          );
          const userResult: UserResult = {
            address: addr,
            deeds: unclaimed,
            totalUnclaimedWei: userTotalWei,
            totalUnclaimedEth: formatEther(userTotalWei),
          };
          results.push(userResult);
          usersWithDeeds++;
          totalDeedsFound += unclaimed.length;
          totalUnclaimedWei += userTotalWei;

          console.log(
            `  ${addr}: ${unclaimed.length} unclaimed deed(s), ${formatEther(userTotalWei)} ETH`,
          );
        } else if (verbose) {
          console.log(
            `  ${addr}: ${deedAddresses.length} deed(s) found but all claimed`,
          );
        }
      }

      // Rate limiting between batches
      await sleep(200);
      console.log('');
    }

    // Summary
    const totalUnclaimedEth = formatEther(totalUnclaimedWei);

    console.log('=== Unclaimed ENS Deposit Report ===\n');
    console.log(`Users checked: ${usersChecked}`);
    console.log(`Users with unclaimed deposits: ${usersWithDeeds}`);
    console.log(`Total unclaimed deeds: ${totalDeedsFound}`);
    console.log(`Total unclaimed ETH: ${totalUnclaimedEth} ETH\n`);

    if (results.length > 0) {
      console.log(
        'Address                                    | Deeds | Unclaimed ETH',
      );
      console.log(
        '-------------------------------------------|-------|-------------',
      );
      for (const r of results.sort(
        (a, b) =>
          Number(b.totalUnclaimedWei - a.totalUnclaimedWei),
      )) {
        console.log(
          `${r.address.padEnd(42)} | ${String(r.deeds.length).padStart(5)} | ${r.totalUnclaimedEth}`,
        );
      }
      console.log('');
    }

    // Save JSON output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = `data/unclaimed-deposits-${timestamp}.json`;

    const output = {
      timestamp: new Date().toISOString(),
      summary: {
        usersChecked,
        usersWithDeeds,
        totalDeedsFound,
        totalUnclaimedEth,
      },
      results: results.map((r) => ({
        address: r.address,
        totalUnclaimedEth: r.totalUnclaimedEth,
        deeds: r.deeds.map((d) => ({
          deedAddress: d.deedAddress,
          balance: d.balance,
        })),
      })),
    };

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`Results saved to: ${outputFile}\n`);
  } catch (error: any) {
    console.error('\nFatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Parse CLI args
const args = process.argv.slice(2);
const options: {
  limit?: number;
  offset?: number;
  batchSize?: number;
  verbose?: boolean;
} = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--offset' && args[i + 1]) {
    options.offset = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--batch-size' && args[i + 1]) {
    options.batchSize = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--verbose') {
    options.verbose = true;
  }
}

checkUnclaimedDeposits(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
