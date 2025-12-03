import {
  createPublicClient,
  http,
  decodeEventLog,
  Log,
  PublicClient,
  parseAbi,
} from 'viem';
import { mainnet } from 'viem/chains';
import PQueue from 'p-queue';
import { config, getPostgresPool, createSale } from '../../../shared/src';
import { logger } from '../utils/logger';
import { ENSResolver } from '../services/ens-resolver';

// Define Seaport ABI with proper event definitions
const SEAPORT_ABI = parseAbi([
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
  'event OrderCancelled(bytes32 orderHash)',
  'event OrderValidated(bytes32 orderHash, address indexed offerer, address indexed zone)',
]);

const SEAPORT_EVENTS = {
  OrderFulfilled: SEAPORT_ABI[0],
  OrderCancelled: SEAPORT_ABI[1],
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
    }
  }

  private async handleOrderFulfilled(args: any, log: Log) {
    const { orderHash, offerer, recipient, offer, consideration } = args;

    // Check if this is an ENS order
    const isENSOrder = offer && offer.some((item: any) =>
      item.token && item.token.toLowerCase() === config.blockchain.ensRegistrarAddress.toLowerCase()
    );

    if (!isENSOrder) {
      // Not an ENS order, skip silently
      return;
    }

    logger.debug('Processing ENS OrderFulfilled event:', {
      orderHash,
      offerer,
      recipient,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash
    });

    // Find the listing that's being sold
    const findListingQuery = `
      SELECT id FROM listings
      WHERE order_hash = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const listingResult = await this.pool.query(findListingQuery, [orderHash]);
    const listingId = listingResult.rows.length > 0 ? listingResult.rows[0].id : undefined;

    // Update listing status (this is also done by the trigger, but kept for backwards compatibility)
    const updateListingQuery = `
      UPDATE listings
      SET status = 'sold', updated_at = NOW()
      WHERE order_hash = $1
    `;

    await this.pool.query(updateListingQuery, [orderHash]);

    // Record the sale transaction
    const block = await this.client.getBlock({ blockNumber: log.blockNumber! });

    for (const item of offer) {
      if (item.token.toLowerCase() === config.blockchain.ensRegistrarAddress.toLowerCase()) {
        const tokenId = item.identifier.toString();
        const price = consideration[0]?.amount?.toString() || '0';

        try {
          // Try to resolve the actual ENS name
          const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
          const nameToStore = resolvedData?.name || `token-${tokenId}`;
          const expiryDate = resolvedData?.expiryDate || null;
          const resolvedOwner = resolvedData?.ownerAddress || null;
          const registrationDate = resolvedData?.registrationDate || null;
          const textRecords = resolvedData?.textRecords || {};

          // Use resolved owner if available, otherwise use recipient
          const ownerAddress = (resolvedOwner || recipient).toLowerCase();

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

          // Record sale in sales table
          try {
            const sale = await createSale({
              ensNameId,
              sellerAddress: offerer.toLowerCase(),
              buyerAddress: recipient.toLowerCase(),
              salePriceWei: price,
              listingId,
              transactionHash: log.transactionHash!,
              blockNumber: Number(log.blockNumber),
              orderHash,
              orderData: {
                offer: this.serializeBigInts(offer),
                consideration: this.serializeBigInts(consideration),
                zone: args.zone,
              },
              source: 'grails', // On-chain Seaport sales tracked by our indexer
              saleDate,
            });

            logger.info(`Sale created in sales table for token ${tokenId}`);

            // Publish club sales stats job if sale has clubs (ETH only)
            if (sale?.clubs && Array.isArray(sale.clubs) && sale.clubs.length > 0) {
              try {
                const PgBoss = require('pg-boss');
                const boss = new PgBoss({ connectionString: config.database.url });
                await boss.start();
                await boss.send('update-club-sales-stats', {
                  clubNames: sale.clubs,
                  salePriceWei: price,
                });
                await boss.stop();
                logger.info(`Published club sales stats job for clubs: ${sale.clubs.join(', ')}`);
              } catch (queueError: any) {
                logger.error(`Failed to publish club sales stats job: ${queueError.message}`);
              }
            }
          } catch (error: any) {
            logger.error(`Failed to create sale record: ${error.message}`);
            // Don't fail the entire handler if sale recording fails
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
            offerer.toLowerCase(),
            recipient.toLowerCase(),
            price,
            saleDate,
          ]);

          // Update ENS owner
          const updateOwnerQuery = `
            UPDATE ens_names
            SET owner_address = $1, last_transfer_date = NOW(), updated_at = NOW()
            WHERE token_id = $2
          `;

          await this.pool.query(updateOwnerQuery, [recipient.toLowerCase(), tokenId]);
        } catch (err: any) {
          logger.error(`Failed to process Seaport sale for token ${tokenId}: ${err.message}`);
          throw err; // Re-throw to be caught by outer handler
        }
      }
    }
  }

  private async handleOrderCancelled(args: any, log: Log) {
    const { orderHash } = args;

    const updateQuery = `
      UPDATE listings
      SET status = 'cancelled', updated_at = NOW()
      WHERE order_hash = $1
    `;

    await this.pool.query(updateQuery, [orderHash]);
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