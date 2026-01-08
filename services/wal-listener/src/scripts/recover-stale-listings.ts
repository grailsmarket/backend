import { getPostgresPool, createSale } from '../../../shared/src';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

/**
 * Recover stale/unfunded listings by checking on-chain for OrderFulfilled events
 *
 * This script:
 * 1. Finds unfunded listings without associated sale records (already marked by validation worker)
 * 2. For listings with order_hash, queries on-chain for Seaport OrderFulfilled events
 * 3. Creates missing sale records for confirmed on-chain sales and marks listings as 'sold'
 * 4. Listings without on-chain sale remain as 'unfunded' (ownership transferred without sale)
 *
 * Usage:
 *   npx ts-node src/scripts/recover-stale-listings.ts [--dry-run] [--verbose] [--limit=N]
 */

const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395';
const ENS_REGISTRAR_ADDRESS = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
const BATCH_SIZE = 20; // Smaller batch for RPC queries

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// Parse --limit argument
let LIMIT = 0;
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
if (limitArg) {
  LIMIT = parseInt(limitArg.split('=')[1]);
}

// Seaport ABI for OrderFulfilled event
const SEAPORT_ABI = parseAbi([
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
]);

interface StaleListingRecord {
  listingId: number;
  ensNameId: number;
  name: string;
  tokenId: string;
  sellerAddress: string;
  orderHash: string | null;
  priceWei: string;
  currencyAddress: string;
  source: string;
  createdAt: Date;
}

interface OnChainSale {
  orderHash: string;
  offerer: string;
  recipient: string;
  tokenId: string;
  price: string;
  transactionHash: string;
  blockNumber: bigint;
  blockTimestamp: Date;
}

// Initialize viem client
const RPC_URL = process.env.RPC_URL || 'https://eth.llamarpc.com';
const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
});

const pool = getPostgresPool();

/**
 * Search for OrderFulfilled event on-chain by seller address within a block range
 * Since orderHash is not indexed, we search by offerer (seller) and then filter
 */
async function findOrderFulfilledBySeller(
  sellerAddress: string,
  orderHash: string,
  fromBlock: bigint,
  toBlock: bigint
): Promise<OnChainSale | null> {
  try {
    // Query logs filtering by offerer (indexed parameter)
    const logs = await client.getLogs({
      address: SEAPORT_ADDRESS as `0x${string}`,
      event: SEAPORT_ABI[0],
      args: {
        offerer: sellerAddress as `0x${string}`,
      },
      fromBlock,
      toBlock,
    });

    // Filter logs to find the one with matching orderHash
    for (const log of logs) {
      // The orderHash is in the non-indexed data, we need to check it
      // In viem, decoded args should have orderHash
      const args = log.args as any;

      if (args.orderHash?.toLowerCase() === orderHash.toLowerCase()) {
        // Found our order! Check if it's an ENS sale
        const offer = args.offer || [];
        const consideration = args.consideration || [];

        // Find the ENS token in the offer
        const ensItem = offer.find((item: any) =>
          item.token?.toLowerCase() === ENS_REGISTRAR_ADDRESS.toLowerCase()
        );

        if (!ensItem) {
          continue; // Not an ENS sale
        }

        // Get block timestamp
        const block = await client.getBlock({ blockNumber: log.blockNumber! });

        // Get price from consideration (first item is typically the payment)
        const price = consideration[0]?.amount?.toString() || '0';

        return {
          orderHash: args.orderHash,
          offerer: args.offerer.toLowerCase(),
          recipient: args.recipient.toLowerCase(),
          tokenId: ensItem.identifier.toString(),
          price,
          transactionHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
          blockTimestamp: new Date(Number(block.timestamp) * 1000),
        };
      }
    }

    return null;
  } catch (error: any) {
    if (VERBOSE) {
      console.error(`Error searching for OrderFulfilled for seller ${sellerAddress}:`, error.message);
    }
    return null;
  }
}

/**
 * Search for any OrderFulfilled event matching the order hash
 * This searches in chunks to avoid RPC limits, starting from most recent blocks
 */
async function findOrderFulfilledByHash(
  orderHash: string,
  sellerAddress: string,
  listingCreatedAt: Date
): Promise<OnChainSale | null> {
  try {
    const currentBlock = await client.getBlockNumber();

    // Calculate approximate block when listing was created
    // Ethereum averages ~12 seconds per block
    const listingAgeMs = Date.now() - listingCreatedAt.getTime();
    const listingAgeBlocks = BigInt(Math.floor(listingAgeMs / 12000));
    const fromBlock = currentBlock - listingAgeBlocks - 1000n; // Add buffer

    // Search in chunks of 1000 blocks (RPC provider limit)
    // Search backwards from current block (recent sales more likely)
    const chunkSize = 1000n;
    const totalBlocks = currentBlock - fromBlock;

    // Limit search to ~30 days worth of blocks to avoid excessive RPC calls
    // 30 days * 24 hours * 60 mins * 5 blocks/min = ~216,000 blocks
    const maxBlocks = 216000n;
    const effectiveFromBlock = totalBlocks > maxBlocks ? currentBlock - maxBlocks : fromBlock;

    let chunksSearched = 0;
    for (let end = currentBlock; end > effectiveFromBlock; end -= chunkSize) {
      const start = end - chunkSize < effectiveFromBlock ? effectiveFromBlock : end - chunkSize;
      chunksSearched++;

      const result = await findOrderFulfilledBySeller(sellerAddress, orderHash, start, end);
      if (result) {
        return result;
      }

      // Add small delay every 10 chunks to avoid rate limiting
      if (chunksSearched % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return null;
  } catch (error: any) {
    if (VERBOSE) {
      console.error(`Error finding OrderFulfilled for hash ${orderHash}:`, error.message);
    }
    return null;
  }
}

async function recoverStaleListings() {
  console.log('=== Recover Stale Listings Script ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Verbose: ${VERBOSE}`);
  console.log(`RPC URL: ${RPC_URL}`);
  if (LIMIT > 0) console.log(`Limit: ${LIMIT}`);
  console.log('');

  // Find unfunded listings without sale records
  // These are listings where the validation worker marked them as unfunded (ownership lost)
  // but we may have missed recording the actual sale
  const query = `
    SELECT
      l.id as listing_id,
      l.ens_name_id,
      l.seller_address,
      l.order_hash,
      l.price_wei,
      l.currency_address,
      l.source,
      l.created_at,
      en.name,
      en.token_id,
      en.owner_address as db_owner_address
    FROM listings l
    JOIN ens_names en ON en.id = l.ens_name_id
    LEFT JOIN sales s ON s.listing_id = l.id
    WHERE l.status = 'unfunded'
    AND en.name NOT LIKE 'token-%'
    AND s.id IS NULL
    ORDER BY l.created_at DESC
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;

  const result = await pool.query(query);
  const staleListings: StaleListingRecord[] = result.rows.map(row => ({
    listingId: row.listing_id,
    ensNameId: row.ens_name_id,
    name: row.name,
    tokenId: row.token_id,
    sellerAddress: row.seller_address.toLowerCase(),
    orderHash: row.order_hash,
    priceWei: row.price_wei,
    currencyAddress: row.currency_address || '0x0000000000000000000000000000000000000000',
    source: row.source || 'opensea',
    createdAt: row.created_at,
  }));

  console.log(`Found ${staleListings.length} unfunded listings without sale records\n`);

  if (staleListings.length === 0) {
    console.log('No listings to recover!');
    await pool.end();
    return;
  }

  // Count how many have order_hash (can be searched on-chain)
  const withOrderHash = staleListings.filter(l => l.orderHash).length;
  const withoutOrderHash = staleListings.filter(l => !l.orderHash).length;
  console.log(`  With order_hash (searchable on-chain): ${withOrderHash}`);
  console.log(`  Without order_hash: ${withoutOrderHash}\n`);

  // Process listings
  let processed = 0;
  let salesCreated = 0;
  let linkedToExisting = 0;
  let markedUnfunded = 0;
  let skipped = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < staleListings.length; i += BATCH_SIZE) {
    const batch = staleListings.slice(i, i + BATCH_SIZE);

    for (const listing of batch) {
      try {
        // First check if there's already a sale with this order_hash
        if (listing.orderHash) {
          const existingSale = await pool.query(
            'SELECT id FROM sales WHERE order_hash = $1 LIMIT 1',
            [listing.orderHash]
          );

          if (existingSale.rows.length > 0) {
            // Sale exists, just mark listing as sold
            if (!DRY_RUN) {
              await pool.query(
                `UPDATE listings SET status = 'sold', updated_at = NOW() WHERE id = $1`,
                [listing.listingId]
              );
            }
            if (VERBOSE) {
              console.log(`[LINKED] ${listing.name} - found existing sale with order_hash`);
            }
            linkedToExisting++;
            processed++;
            continue;
          }
        }

        // Check for existing sale by ens_name_id + seller after listing creation
        const recentSale = await pool.query(`
          SELECT id, transaction_hash FROM sales
          WHERE ens_name_id = $1 AND seller_address = $2 AND sale_date >= $3
          ORDER BY sale_date DESC LIMIT 1
        `, [listing.ensNameId, listing.sellerAddress, listing.createdAt]);

        if (recentSale.rows.length > 0) {
          const sale = recentSale.rows[0];
          if (!DRY_RUN) {
            await pool.query(
              `UPDATE sales SET listing_id = $1 WHERE id = $2 AND listing_id IS NULL`,
              [listing.listingId, sale.id]
            );
            await pool.query(
              `UPDATE listings SET status = 'sold', updated_at = NOW() WHERE id = $1`,
              [listing.listingId]
            );
          }
          if (VERBOSE) {
            console.log(`[LINKED] ${listing.name} - linked to existing sale ${sale.id}`);
          }
          linkedToExisting++;
          processed++;
          continue;
        }

        // Try to find the sale on-chain if we have an order_hash
        if (listing.orderHash) {
          if (VERBOSE) {
            console.log(`[SEARCH] ${listing.name} - searching on-chain for order ${listing.orderHash}...`);
          }

          const onChainSale = await findOrderFulfilledByHash(
            listing.orderHash,
            listing.sellerAddress,
            listing.createdAt
          );

          if (onChainSale) {
            // Found the sale on-chain! Create the sale record
            if (VERBOSE) {
              console.log(`[FOUND] ${listing.name} - tx: ${onChainSale.transactionHash.slice(0, 10)}..., buyer: ${onChainSale.recipient.slice(0, 10)}..., price: ${onChainSale.price}`);
            }

            if (!DRY_RUN) {
              try {
                await createSale({
                  ensNameId: listing.ensNameId,
                  sellerAddress: onChainSale.offerer,
                  buyerAddress: onChainSale.recipient,
                  salePriceWei: onChainSale.price,
                  currencyAddress: listing.currencyAddress,
                  listingId: listing.listingId,
                  transactionHash: onChainSale.transactionHash,
                  blockNumber: Number(onChainSale.blockNumber),
                  orderHash: onChainSale.orderHash,
                  orderData: null,
                  source: listing.source,
                  saleDate: onChainSale.blockTimestamp,
                });

                // Mark listing as sold
                await pool.query(
                  `UPDATE listings SET status = 'sold', updated_at = NOW() WHERE id = $1`,
                  [listing.listingId]
                );
              } catch (saleError: any) {
                // Could be duplicate - check if sale was created by trigger
                if (saleError.message?.includes('duplicate') || saleError.code === '23505') {
                  if (VERBOSE) {
                    console.log(`[DUPLICATE] ${listing.name} - sale already exists (likely from trigger)`);
                  }
                } else {
                  throw saleError;
                }
              }
            }

            salesCreated++;
            processed++;
            continue;
          }
        }

        // No on-chain sale found - listing remains as unfunded
        // (Already marked as unfunded by validation worker, no action needed)
        if (VERBOSE) {
          console.log(`[NO_SALE] ${listing.name} - no on-chain sale found, remains unfunded`);
        }
        markedUnfunded++;
        processed++;

      } catch (error: any) {
        console.error(`[ERROR] ${listing.name}:`, error.message);
        errors++;
        processed++;
      }
    }

    // Progress update
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const eta = (staleListings.length - processed) / rate;

    console.log(
      `Progress: ${processed}/${staleListings.length} | ` +
      `Sales: ${salesCreated} | Linked: ${linkedToExisting} | ` +
      `Unfunded: ${markedUnfunded} | Skip: ${skipped} | Err: ${errors} | ` +
      `ETA: ${Math.round(eta)}s`
    );
  }

  console.log('\n=== Summary ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Sales created from on-chain data: ${salesCreated}`);
  console.log(`Linked to existing sales: ${linkedToExisting}`);
  console.log(`Marked as unfunded: ${markedUnfunded}`);
  console.log(`Skipped (seller still owns): ${skipped}`);
  console.log(`Errors: ${errors}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes were made to the database.');
  }

  await pool.end();
}

recoverStaleListings()
  .then(() => {
    console.log('\nScript completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
