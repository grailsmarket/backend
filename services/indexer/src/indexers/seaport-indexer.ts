import {
  createPublicClient,
  http,
  decodeEventLog,
  type Log,
  type PublicClient,
  parseAbi,
} from 'viem';
import { mainnet } from 'viem/chains';
import PQueue from 'p-queue';
import { config, getPostgresPool, createSale } from '../../../shared/src';
import { logger } from '../utils/logger';
import { ENSResolver } from '../services/ens-resolver';
import { safePublishJob, QUEUE_NAMES } from '../queue';

// Define Seaport ABI with proper event definitions
const SEAPORT_ABI = parseAbi([
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
  'event OrderCancelled(bytes32 orderHash)',
  'event OrderValidated(bytes32 orderHash, address indexed offerer, address indexed zone)',
  'event CounterIncremented(uint256 newCounter, address indexed offerer)',
]);

const SEAPORT_EVENTS = {
  OrderFulfilled: SEAPORT_ABI[0],
  OrderCancelled: SEAPORT_ABI[1],
  CounterIncremented: SEAPORT_ABI[3],
} as const;

export class SeaportIndexer {
  private client: PublicClient;
  private pool = getPostgresPool();
  private queue: PQueue;
  private resolver: ENSResolver;
  private isRunning = false;
  private currentBlock = 0n;
  private readonly batchSize = 100; // Reduced for better RPC compatibility
  private readonly confirmations = BigInt(config.blockchain.confirmations);

  constructor() {
    this.client = createPublicClient({
      chain: mainnet,
      transport: http(config.blockchain.rpcUrl),
    });
    this.queue = new PQueue({ concurrency: 5 });
    this.resolver = new ENSResolver();
  }

  async start() {
    logger.info('Starting Seaport indexer...');
    this.isRunning = true;

    const lastBlock = await this.getLastProcessedBlock();
    const startBlock = lastBlock > 0
      ? BigInt(lastBlock) + 1n
      : BigInt(config.blockchain.startBlock || 19000000); // Seaport deployed later

    this.currentBlock = startBlock;
    logger.info(`Starting Seaport indexer from block ${this.currentBlock}`);

    this.indexLoop();
  }

  async stop() {
    logger.info('Stopping Seaport indexer...');
    this.isRunning = false;
    await this.queue.onIdle();
  }

  private async indexLoop() {
    while (this.isRunning) {
      try {
        const latestBlock = await this.client.getBlockNumber();
        const targetBlock = latestBlock - this.confirmations;

        if (this.currentBlock > targetBlock) {
          await new Promise(resolve => setTimeout(resolve, 12000));
          continue;
        }

        const toBlock = this.currentBlock + BigInt(this.batchSize) - 1n;
        const actualToBlock = toBlock > targetBlock ? targetBlock : toBlock;

        await this.indexBlockRange(this.currentBlock, actualToBlock);
        await this.updateLastProcessedBlock(actualToBlock);

        this.currentBlock = actualToBlock + 1n;
      } catch (error: any) {
        logger.error(`Error in Seaport index loop at block ${this.currentBlock}:`, {
          error: error.message,
          code: error.code,
          details: error.shortMessage || error.details
        });
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  private async indexBlockRange(fromBlock: bigint, toBlock: bigint) {
    logger.info(`Indexing Seaport events from block ${fromBlock} to ${toBlock}`);

    const logs = await this.client.getLogs({
      address: config.blockchain.seaportAddress as `0x${string}`,
      fromBlock,
      toBlock,
    });

    const relevantLogs = logs.filter(log => this.isENSRelated(log));

    for (const log of relevantLogs) {
      await this.queue.add(async () => {
        await this.processLog(log);
      });
    }

    await this.queue.onIdle();
  }

  private isENSRelated(log: Log): boolean {
    // We can't easily filter at this stage without decoding,
    // but we're already filtering in handleOrderFulfilled
    // For now, return true and let the event handlers filter
    return true;
  }

  private async processLog(log: Log) {
    let eventName: string | undefined;
    let decodedLog: any;

    try {
      for (const [name, event] of Object.entries(SEAPORT_EVENTS)) {
        try {
          decodedLog = decodeEventLog({
            abi: [event],
            data: log.data,
            topics: log.topics as any,
          });
          eventName = name;
          break;
        } catch {
          continue;
        }
      }

      if (!eventName || !decodedLog) {
        return;
      }

      await this.processEvent(eventName, decodedLog.args, log);
    } catch (error: any) {
      const errorDetails = {
        message: error.message || 'No error message',
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        eventName: eventName || 'unknown',
        topics: log.topics?.slice(0, 2) // Log first 2 topics for debugging
      };

      logger.error(
        `Error processing Seaport log at block ${log.blockNumber}: ${error.message || 'Unknown error'}`
      );
      logger.error(`Transaction: ${log.transactionHash}, Event: ${eventName || 'unknown'}`);

      // Log stack trace separately if available
      if (error.stack && config.monitoring.logLevel === 'debug') {
        logger.debug('Stack trace:', error.stack);
      }
    }
  }

  private serializeBigInts(obj: any): any {
    if (typeof obj === 'bigint') {
      return obj.toString();
    } else if (Array.isArray(obj)) {
      return obj.map(item => this.serializeBigInts(item));
    } else if (obj !== null && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.serializeBigInts(value);
      }
      return result;
    }
    return obj;
  }

  private async saveEvent(event: any) {
    const query = `
      INSERT INTO blockchain_events (
        block_number, transaction_hash, log_index,
        contract_address, event_name, event_data, processed
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (transaction_hash, log_index) DO NOTHING
    `;

    // Convert BigInts in eventData to strings for JSON serialization
    const serializedEventData = this.serializeBigInts(event.eventData);

    await this.pool.query(query, [
      event.blockNumber?.toString(),
      event.transactionHash,
      event.logIndex,
      event.contractAddress,
      event.eventName,
      JSON.stringify(serializedEventData),
      event.processed,
    ]);
  }

  private async processEvent(eventName: string, args: any, log: Log) {
    switch (eventName) {
      case 'OrderFulfilled':
        await this.handleOrderFulfilled(args, log);
        break;
      case 'OrderCancelled':
        await this.handleOrderCancelled(args, log);
        break;
      case 'CounterIncremented':
        await this.handleCounterIncremented(args, log);
        break;
    }
  }

  private async handleOrderFulfilled(args: any, log: Log) {
    const { orderHash, offerer, recipient, offer, consideration } = args;

    // Check if this is an ENS order (either Base Registrar or Name Wrapper)
    // Must check BOTH offer and consideration arrays:
    //   - Listing fulfillment: ENS token is in `offer` (seller offers ENS, buyer pays)
    //   - Offer acceptance: ENS token is in `consideration` (buyer offered WETH, seller fulfills with ENS)
    const ensRegistrar = config.blockchain.ensRegistrarAddress.toLowerCase();
    const ensNameWrapper = config.blockchain.ensNameWrapperAddress.toLowerCase();

    const isENSToken = (token: string) =>
      token.toLowerCase() === ensRegistrar || token.toLowerCase() === ensNameWrapper;

    const ensInOffer = offer && offer.some((item: any) =>
      item.token && isENSToken(item.token)
    );

    const ensInConsideration = consideration && consideration.some((item: any) =>
      item.token && isENSToken(item.token)
    );

    if (!ensInOffer && !ensInConsideration) {
      // Not an ENS order, skip silently
      return;
    }

    // Determine order type:
    //   - Listing fulfillment: ENS in offer, offerer=seller, recipient=buyer
    //   - Offer acceptance: ENS in consideration, offerer=buyer (made the offer), recipient=seller (fulfilled it)
    const isOfferAcceptance = !ensInOffer && ensInConsideration;

    // Extract ENS items and payment items from the correct arrays
    const ensItems = isOfferAcceptance ? consideration : offer;
    const paymentItems = isOfferAcceptance ? offer : consideration;

    // Determine correct buyer/seller based on order type
    const sellerAddress = isOfferAcceptance ? recipient : offerer;
    const buyerAddress = isOfferAcceptance ? offerer : recipient;

    logger.debug('Processing ENS OrderFulfilled event:', {
      orderHash,
      offerer,
      recipient,
      isOfferAcceptance,
      sellerAddress,
      buyerAddress,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash
    });

    // Check if a sale already exists for this order_hash or transaction_hash
    // OpenSea stream may not always include order_hash, so we check both
    const existingSaleQuery = `
      SELECT id, source FROM sales
      WHERE order_hash = $1 OR transaction_hash = $2
      LIMIT 1
    `;
    const existingSaleResult = await this.pool.query(existingSaleQuery, [orderHash, log.transactionHash]);

    if (existingSaleResult.rows.length > 0) {
      logger.debug(`Sale already exists for order_hash ${orderHash} or tx ${log.transactionHash} (source: ${existingSaleResult.rows[0].source}), skipping sale creation`);
      // Still update the listing status below, but don't create duplicate sale
    }

    // Find the listing that's being sold and check its source
    const findListingQuery = `
      SELECT id, source FROM listings
      WHERE order_hash = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const listingResult = await this.pool.query(findListingQuery, [orderHash]);
    const listingId = listingResult.rows.length > 0 ? listingResult.rows[0].id : undefined;
    const listingSource = listingResult.rows.length > 0 ? listingResult.rows[0].source : null;

    // If no listing found, check if this is an offer acceptance
    let offerId: number | undefined;
    let offerSource: string | null = null;
    if (!listingId) {
      const findOfferQuery = `
        SELECT id, source FROM offers
        WHERE order_hash = $1
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const offerResult = await this.pool.query(findOfferQuery, [orderHash]);
      if (offerResult.rows.length > 0) {
        offerId = offerResult.rows[0].id;
        offerSource = offerResult.rows[0].source;
      }
    }

    // Update listing status (this is also done by the trigger, but kept for backwards compatibility)
    const updateListingQuery = `
      UPDATE listings
      SET status = 'sold', updated_at = NOW()
      WHERE order_hash = $1
    `;

    await this.pool.query(updateListingQuery, [orderHash]);

    // Record the sale transaction
    const block = await this.client.getBlock({ blockNumber: log.blockNumber! });

    for (const item of ensItems) {
      const tokenAddress = item.token.toLowerCase();
      if (!isENSToken(tokenAddress)) {
        continue;
      }

      const tokenId = item.identifier.toString();
      const isWrapped = tokenAddress === ensNameWrapper;

      // Calculate total sale price from payment items
      // For listing fulfillment: sum ERC20/ETH from consideration (excluding ENS tokens)
      // For offer acceptance: sum ERC20/ETH from offer (the buyer's payment)
      let totalPrice = BigInt(0);
      let currencyAddress = '0x0000000000000000000000000000000000000000'; // Default to ETH

      for (const payItem of paymentItems) {
        const payToken = payItem.token?.toLowerCase() || '';
        const isPaymentToken = !isENSToken(payToken);

        if (isPaymentToken && payItem.amount) {
          totalPrice += BigInt(payItem.amount.toString());
          // Use the first payment token as the currency
          if (currencyAddress === '0x0000000000000000000000000000000000000000' && payToken) {
            currencyAddress = payToken;
          }
        }
      }

      const price = totalPrice.toString();

      if (isWrapped) {
        logger.info(`Processing wrapped ENS token sale (Name Wrapper): tokenId=${tokenId}, tx=${log.transactionHash}`);
      }

      if (isOfferAcceptance) {
        logger.info(`Processing offer acceptance sale: tokenId=${tokenId}, seller=${sellerAddress}, buyer=${buyerAddress}, price=${price}, tx=${log.transactionHash}`);
      }

      try {
        // Try to resolve the actual ENS name
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
        const nameToStore = resolvedData?.name || `token-${tokenId}`;
        const expiryDate = resolvedData?.expiryDate || null;
        const resolvedOwner = resolvedData?.ownerAddress || null;
        const registrationDate = resolvedData?.registrationDate || null;
        const textRecords = resolvedData?.textRecords || {};

        // Use resolved owner if available, otherwise use buyer (new owner after sale)
        const ownerAddress = (resolvedOwner || buyerAddress).toLowerCase();

        // First ensure the ENS name exists in the database
        const upsertQuery = `
          INSERT INTO ens_names (token_id, name, owner_address, expiry_date, registration_date, metadata, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (token_id) DO UPDATE
          SET
            owner_address = EXCLUDED.owner_address,
            name = CASE
              WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.name
              ELSE ens_names.name
            END,
            expiry_date = COALESCE(EXCLUDED.expiry_date, ens_names.expiry_date),
            registration_date = COALESCE(EXCLUDED.registration_date, ens_names.registration_date),
            metadata = COALESCE(EXCLUDED.metadata, ens_names.metadata),
            updated_at = NOW()
          RETURNING id
        `;

        const nameResult = await this.pool.query(upsertQuery, [
          tokenId,
          nameToStore,
          ownerAddress,
          expiryDate,
          registrationDate,
          JSON.stringify(textRecords)
        ]);

        const ensNameId = nameResult.rows[0].id;

        logger.debug(`Seaport sale for ENS ${nameToStore} (token ${tokenId})`);

        const saleDate = new Date(Number(block.timestamp) * 1000);

        // Create a sale record if no sale exists yet for this order_hash or transaction_hash
        // This allows the Seaport indexer to act as a backup when OpenSea Stream misses events
        const saleAlreadyExists = existingSaleResult.rows.length > 0;

        if (!saleAlreadyExists) {
          // Record sale in sales table - use listing/offer source or default to 'opensea'
          const saleSource = listingSource || offerSource || 'opensea';
          try {
            const sale = await createSale({
              ensNameId,
              sellerAddress: sellerAddress.toLowerCase(),
              buyerAddress: buyerAddress.toLowerCase(),
              salePriceWei: price,
              currencyAddress,
              listingId,
              offerId,
              transactionHash: log.transactionHash!,
              blockNumber: Number(log.blockNumber),
              orderHash,
              orderData: {
                offer: this.serializeBigInts(offer),
                consideration: this.serializeBigInts(consideration),
                zone: args.zone,
              },
              source: saleSource,
              saleDate,
            });

            logger.info(`Sale created in sales table for token ${tokenId} (source: ${saleSource}, offerAcceptance: ${isOfferAcceptance})`);

            // Publish club sales stats job if sale has clubs (ETH only)
            if (sale?.clubs && Array.isArray(sale.clubs) && sale.clubs.length > 0) {
              const published = await safePublishJob(QUEUE_NAMES.UPDATE_CLUB_SALES_STATS, {
                clubNames: sale.clubs,
                salePriceWei: price,
              }, 'seaport_order_fulfilled');

              if (published) {
                logger.info(`Published club sales stats job for clubs: ${sale.clubs.join(', ')}`);
              }
            }
          } catch (error: any) {
            logger.error(`Failed to create sale record: ${error.message}`);
            // Don't fail the entire handler if sale recording fails
          }
        } else {
          logger.debug(`Skipping sale creation for ${nameToStore} - sale already exists for order_hash ${orderHash} or tx ${log.transactionHash}`);
        }

        // Cancel all other active listings for this ENS name
        // After a sale, ownership has transferred, so all other listings from the seller are invalid
        const cancelOtherListingsQuery = `
          UPDATE listings
          SET status = 'cancelled',
              updated_at = NOW()
          WHERE ens_name_id = $1
            AND status = 'active'
            AND order_hash IS DISTINCT FROM $2
          RETURNING id, source
        `;

        const cancelledListings = await this.pool.query(cancelOtherListingsQuery, [ensNameId, orderHash]);

        if (cancelledListings.rows.length > 0) {
          logger.info(`Cancelled ${cancelledListings.rows.length} other active listings for ENS ${nameToStore} after sale (sources: ${cancelledListings.rows.map((r: any) => r.source).join(', ')})`);
        }

        // Insert the transaction
        const txQuery = `
          INSERT INTO transactions (
            ens_name_id, transaction_hash, block_number,
            from_address, to_address, price_wei,
            transaction_type, timestamp
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'sale', $7)
          ON CONFLICT (transaction_hash) DO NOTHING
        `;

        await this.pool.query(txQuery, [
          ensNameId,
          log.transactionHash,
          log.blockNumber?.toString(),
          sellerAddress.toLowerCase(),
          buyerAddress.toLowerCase(),
          price,
          saleDate,
        ]);

        // Update ENS owner to the buyer
        const updateOwnerQuery = `
          UPDATE ens_names
          SET owner_address = $1, last_transfer_date = NOW(), updated_at = NOW()
          WHERE token_id = $2
        `;

        await this.pool.query(updateOwnerQuery, [buyerAddress.toLowerCase(), tokenId]);
      } catch (err: any) {
        logger.error(`Failed to process Seaport sale for token ${tokenId}: ${err.message}`);
        throw err; // Re-throw to be caught by outer handler
      }
    }
  }

  private async handleOrderCancelled(args: any, log: Log) {
    const { orderHash } = args;

    // Cancel matching listing
    await this.pool.query(
      `UPDATE listings SET status = 'cancelled', updated_at = NOW() WHERE order_hash = $1`,
      [orderHash]
    );

    // Cancel matching offer
    const cancelledOffer = await this.pool.query(
      `UPDATE offers SET status = 'cancelled' WHERE order_hash = $1 AND status = 'pending' RETURNING id, ens_name_id`,
      [orderHash]
    );

    // Recalculate highest offer if an offer was cancelled
    if (cancelledOffer.rows.length > 0) {
      const row = cancelledOffer.rows[0];
      logger.info(`Cancelled offer ${row.id} for order_hash ${orderHash} via OrderCancelled event`);
      await safePublishJob('recalculate-highest-offer', { ensNameId: row.ens_name_id }, 'order_cancelled');
    }
  }

  private async handleCounterIncremented(args: any, log: Log) {
    const { newCounter, offerer } = args;
    const offererAddress = offerer.toLowerCase();

    logger.info(`Processing CounterIncremented event for ${offererAddress}, new counter: ${newCounter}`, {
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash
    });

    // Cancel all active listings from this seller
    // When a user increments their counter, ALL their existing Seaport orders become invalid
    const cancelListingsQuery = `
      UPDATE listings
      SET status = 'cancelled', updated_at = NOW()
      WHERE seller_address = $1
        AND status = 'active'
      RETURNING id, order_hash
    `;

    const cancelledListings = await this.pool.query(cancelListingsQuery, [offererAddress]);

    if (cancelledListings.rows.length > 0) {
      logger.info(`Cancelled ${cancelledListings.rows.length} active listings for ${offererAddress} due to counter increment`);
    }

    // Cancel all pending offers from this buyer
    // Offers are also Seaport orders that become invalid when the counter is incremented
    const cancelOffersQuery = `
      UPDATE offers
      SET status = 'cancelled'
      WHERE buyer_address = $1
        AND status = 'pending'
      RETURNING id, order_hash, ens_name_id, bulk_offer_group_id
    `;

    const cancelledOffers = await this.pool.query(cancelOffersQuery, [offererAddress]);

    if (cancelledOffers.rows.length > 0) {
      logger.info(`Cancelled ${cancelledOffers.rows.length} pending offers for ${offererAddress} due to counter increment`);

      // Recalculate highest offer for all affected ENS names
      const affectedEnsNameIds = [...new Set(cancelledOffers.rows.map((r: any) => r.ens_name_id))];
      for (const ensNameId of affectedEnsNameIds) {
        await safePublishJob('recalculate-highest-offer', { ensNameId }, 'counter_incremented');
      }

      // Cancel any bulk_offer_groups that are now fully cancelled
      const affectedGroupIds = [...new Set(
        cancelledOffers.rows
          .map((r: any) => r.bulk_offer_group_id)
          .filter((id: any) => id != null)
      )];

      if (affectedGroupIds.length > 0) {
        await this.pool.query(
          `UPDATE bulk_offer_groups SET status = 'cancelled', cancelled_at = NOW()
           WHERE id = ANY($1)
             AND NOT EXISTS (
               SELECT 1 FROM offers WHERE bulk_offer_group_id = bulk_offer_groups.id AND status = 'pending'
             )`,
          [affectedGroupIds]
        );
      }
    }
  }

  private async getLastProcessedBlock(): Promise<number> {
    const query = `
      SELECT last_processed_block FROM indexer_state
      WHERE contract_address = $1
    `;

    const result = await this.pool.query(query, [config.blockchain.seaportAddress]);
    return result.rows.length > 0 ? parseInt(result.rows[0].last_processed_block) : 0;
  }

  private async updateLastProcessedBlock(blockNumber: bigint) {
    const query = `
      INSERT INTO indexer_state (contract_address, last_processed_block)
      VALUES ($1, $2)
      ON CONFLICT (contract_address) DO UPDATE
      SET last_processed_block = EXCLUDED.last_processed_block,
          last_processed_timestamp = NOW(),
          updated_at = NOW()
    `;

    await this.pool.query(query, [
      config.blockchain.seaportAddress,
      blockNumber.toString(),
    ]);
  }
}