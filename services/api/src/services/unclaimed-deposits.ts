import { createPublicClient, http, formatEther, parseAbi, keccak256, toBytes } from 'viem';
import { mainnet } from 'viem/chains';
import { config } from '../../../shared/src';

const OLD_REGISTRAR = '0x6090a6e47849629b7245dfa1ca21d94cd15878ef';
const RECLAIM_SUBGRAPH_ID = '8zhr2kf1ka6B4sLmuhEzo8gQ7FTjay6DXQrefmRtNb8W';

const HASH_REGISTERED_TOPIC0 = keccak256(toBytes('HashRegistered(bytes32,address,uint256,uint256)'));
const FROM_BLOCK = 3648534;
const TO_BLOCK = 9380471;

const registrarAbi = parseAbi([
  'function entries(bytes32 _hash) view returns (uint8, address, uint256, uint256, uint256)',
]);

interface SubgraphDeed {
  id: string;
  value: string;
}

export interface UnclaimedDepositsResult {
  address: string;
  deeds: { deedAddress: string; balance: string }[];
  totalUnclaimedEth: string;
  totalUnclaimedWei: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function querySubgraphForDeeds(address: string): Promise<SubgraphDeed[]> {
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
      variables: { addresses: [address.toLowerCase()] },
    }),
  });

  if (!response.ok) {
    throw new Error(`Subgraph API error: ${response.status} ${response.statusText}`);
  }

  const result: any = await response.json();

  if (result.errors) {
    throw new Error(`Subgraph GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  const account = result.data?.accounts?.[0];
  if (account?.deeds && account.deeds.length > 0) {
    return account.deeds;
  }

  return [];
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

  return data.result.map((log: any) => log.topics[1]);
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

export async function fetchUnclaimedDeposits(address: string): Promise<UnclaimedDepositsResult> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  // Try subgraph first, fall back to Etherscan
  let deedAddresses: string[] = [];

  try {
    const subgraphDeeds = await querySubgraphForDeeds(address);
    deedAddresses = subgraphDeeds.map((d) => d.id);
  } catch {
    // Fallback to Etherscan
    const nameHashes = await queryEtherscanForDeeds(address);
    for (const nameHash of nameHashes) {
      const deedAddr = await getDeedAddressFromRegistrar(client, nameHash);
      if (deedAddr) {
        deedAddresses.push(deedAddr);
      }
      await sleep(100);
    }
  }

  // Verify on-chain balances
  const deeds: { deedAddress: string; balance: string }[] = [];
  let totalUnclaimedWei = 0n;

  for (const deedAddr of deedAddresses) {
    try {
      const balance = await client.getBalance({
        address: deedAddr as `0x${string}`,
      });

      if (balance > 0n) {
        deeds.push({
          deedAddress: deedAddr,
          balance: formatEther(balance),
        });
        totalUnclaimedWei += balance;
      }
    } catch {
      // Retry once after delay
      await sleep(5000);
      try {
        const balance = await client.getBalance({
          address: deedAddr as `0x${string}`,
        });
        if (balance > 0n) {
          deeds.push({
            deedAddress: deedAddr,
            balance: formatEther(balance),
          });
          totalUnclaimedWei += balance;
        }
      } catch {
        // Skip this deed
      }
    }
    await sleep(50);
  }

  return {
    address: address.toLowerCase(),
    deeds,
    totalUnclaimedEth: formatEther(totalUnclaimedWei),
    totalUnclaimedWei: totalUnclaimedWei.toString(),
  };
}
