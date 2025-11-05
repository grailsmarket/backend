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
import { config, getPostgresPool, BlockchainEvent } from '../../../shared/src';
import { logger } from '../utils/logger';
import { ENSResolver } from '../services/ens-resolver';

// Define ENS ABI with proper event definitions
const ENS_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires)',
  'event NameRenewed(uint256 indexed id, uint256 expires)',
  'event NameMigrated(uint256 indexed id, address indexed owner, uint256 expires)',
]);

const ENS_EVENTS = {
  Transfer: ENS_ABI[0],
  NameRegistered: ENS_ABI[1],
  NameRenewed: ENS_ABI[2],
} as const;

export class ENSIndexer {
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
    logger.info('Starting ENS indexer...');
    this.isRunning = true;

    const lastBlock = await this.getLastProcessedBlock();
    const startBlock = lastBlock > 0
      ? BigInt(lastBlock) + 1n
      : BigInt(config.blockchain.startBlock || 0);

    this.currentBlock = startBlock;
    logger.info(`Starting from block ${this.currentBlock}`);

    this.indexLoop();
  }

  async stop() {
    logger.info('Stopping ENS indexer...');
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
        logger.error(`Error in index loop at block ${this.currentBlock}:`, {
          error: error.message,
          code: error.code,
          details: error.shortMessage || error.details
        });
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  private async indexBlockRange(fromBlock: bigint, toBlock: bigint) {
    logger.info(`Indexing ENS events from block ${fromBlock} to ${toBlock}`);

    const logs = await this.client.getLogs({
      address: config.blockchain.ensRegistrarAddress as `0x${string}`,
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
      await this.queue.add(async () => {
        await this.processLog(log);
      });
    }

    await this.queue.onIdle();
  }

  private async processLog(log: Log) {
    try {
      let eventName: string | undefined;
      let decodedLog: any;

      // Try to decode the log against our known events
      for (const [name, event] of Object.entries(ENS_EVENTS)) {
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
        // This is not one of our tracked events, skip it
        return;
      }

      logger.debug(`Processing ${eventName} event at block ${log.blockNumber}`);

      const blockchainEvent: Partial<BlockchainEvent> = {
        blockNumber: log.blockNumber || 0n,
        transactionHash: log.transactionHash || '',
        logIndex: log.logIndex || 0,
        contractAddress: log.address,
        eventName,
        eventData: decodedLog.args as any,
        processed: false,
      };

      await this.saveEvent(blockchainEvent);
      await this.processEvent(eventName, decodedLog.args, log);
    } catch (error: any) {
      // Only log actual errors, not decode failures
      console.error(`Error processing log at block ${log.blockNumber}:`, {
        error: error.message,
        code: error.code,
        transactionHash: log.transactionHash,
        topics: log.topics?.slice(0, 2), // Just first 2 topics for brevity
      });
    }
  }

  private async saveEvent(event: Partial<BlockchainEvent>) {
    const query = `
      INSERT INTO blockchain_events (
        block_number, transaction_hash, log_index,
        contract_address, event_name, event_data, processed
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (transaction_hash, log_index) DO NOTHING
    `;

    // Convert BigInts in eventData to strings for JSON serialization
    const eventData = event.eventData ? this.serializeBigInts(event.eventData) : {};

    await this.pool.query(query, [
      event.blockNumber?.toString(),
      event.transactionHash,
      event.logIndex,
      event.contractAddress,
      event.eventName,
      JSON.stringify(eventData),
      event.processed,
    ]);
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

  private calculateNameAttributes(name: string) {
    return {
      has_numbers: /\d/.test(name),
      has_emoji: /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(name),
    };
  }

  private async processEvent(eventName: string, args: any, log: Log) {
    try {
      switch (eventName) {
        case 'Transfer':
          await this.handleTransfer(args, log);
          break;
        case 'NameRegistered':
          await this.handleNameRegistered(args, log);
          break;
        case 'NameRenewed':
          await this.handleNameRenewed(args, log);
          break;
        default:
          logger.debug(`Unhandled event type: ${eventName}`);
      }
    } catch (error: any) {
      logger.error(`Error processing ${eventName} event:`, {
        error: error.message,
        args,
        blockNumber: log.blockNumber?.toString()
      });
      throw error;
    }
  }

  private async handleTransfer(args: any, log: Log) {
    const { from, to, tokenId } = args;
    const tokenIdStr = typeof tokenId === 'bigint' ? tokenId.toString() : String(tokenId);

    let ensNameId: number | null = null;

    try {
      // First, check if this token_id already exists in our database
      const existingRecord = await this.pool.query(
        'SELECT id, name, has_numbers, has_emoji FROM ens_names WHERE token_id = $1',
        [tokenIdStr]
      );

      let nameToStore: string;
      let has_numbers: boolean;
      let has_emoji: boolean;

      if (existingRecord.rows.length > 0) {
        // Record exists - use the existing name instead of calling The Graph
        nameToStore = existingRecord.rows[0].name;
        has_numbers = existingRecord.rows[0].has_numbers;
        has_emoji = existingRecord.rows[0].has_emoji;
      } else {
        // Record doesn't exist - try to resolve from The Graph
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);
        nameToStore = resolvedData?.name || `token-${tokenIdStr}`; // Fallback to placeholder if not resolved
        const attributes = this.calculateNameAttributes(nameToStore);
        has_numbers = attributes.has_numbers;
        has_emoji = attributes.has_emoji;
      }

      // Check if this name exists with a different token_id (edge case)
      const duplicateName = await this.pool.query(
        'SELECT id FROM ens_names WHERE name = $1 AND token_id != $2',
        [nameToStore, tokenIdStr]
      );

      let result;

      if (duplicateName.rows.length > 0) {
        // Name exists with different token_id - just update the existing record
        result = await this.pool.query(
          `UPDATE ens_names SET
            owner_address = $1,
            last_transfer_date = NOW(),
            updated_at = NOW()
          WHERE token_id = $2
          RETURNING id`,
          [to.toLowerCase(), tokenIdStr]
        );
      } else if (existingRecord.rows.length > 0) {
        // Name exists, just update it
        const updateQuery = `
          UPDATE ens_names SET
            owner_address = $1,
            name = CASE
              WHEN name LIKE 'token-%' THEN $2
              ELSE name
            END,
            has_numbers = CASE
              WHEN name LIKE 'token-%' THEN $3
              ELSE has_numbers
            END,
            has_emoji = CASE
              WHEN name LIKE 'token-%' THEN $4
              ELSE has_emoji
            END,
            last_transfer_date = NOW(),
            updated_at = NOW()
          WHERE name = $2
          RETURNING id
        `;

        result = await this.pool.query(updateQuery, [
          to.toLowerCase(),
          nameToStore,
          has_numbers,
          has_emoji
        ]);
      } else {
        // Name doesn't exist, insert it
        const upsertQuery = `
          INSERT INTO ens_names (token_id, name, owner_address, last_transfer_date, has_numbers, has_emoji)
          VALUES ($1, $2, $3, NOW(), $4, $5)
          ON CONFLICT (token_id) DO UPDATE SET
            owner_address = EXCLUDED.owner_address,
            name = CASE
              WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.name
              ELSE ens_names.name
            END,
            has_numbers = CASE
              WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.has_numbers
              ELSE ens_names.has_numbers
            END,
            has_emoji = CASE
              WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.has_emoji
              ELSE ens_names.has_emoji
            END,
            last_transfer_date = NOW(),
            updated_at = NOW()
          RETURNING id
        `;

        result = await this.pool.query(upsertQuery, [
          tokenIdStr,
          nameToStore,
          to.toLowerCase(),
          has_numbers,
          has_emoji
        ]);
      }

      if (result.rows.length > 0) {
        ensNameId = result.rows[0].id;
      }
    } catch (error: any) {
      // If we get a unique constraint violation on name, it means the name already exists
      // with a different token_id. Fetch the existing record by name.
      if (error.code === '23505' && error.constraint === 'ens_names_real_name_unique') {
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);
        const nameToStore = resolvedData?.name || `token-${tokenIdStr}`;
        logger.warn(`ENS name "${nameToStore}" already exists with different token_id. Fetching existing record.`);

        const existingQuery = 'SELECT id FROM ens_names WHERE name = $1';
        const existingResult = await this.pool.query(existingQuery, [nameToStore]);

        if (existingResult.rows.length > 0) {
          ensNameId = existingResult.rows[0].id;
        }
      } else {
        logger.error('Failed to upsert ENS name:', {
          error: error.message,
          tokenId: tokenIdStr,
          to
        });
        throw error;
      }
    }

    // Publish ownership update job to queue
    if (ensNameId) {
      try {
        const { getQueueClient, QUEUE_NAMES } = await import('../queue');
        const boss = await getQueueClient();

        await boss.send(QUEUE_NAMES.UPDATE_OWNERSHIP, {
          ensNameId,
          newOwner: to.toLowerCase(),
          blockNumber: Number(log.blockNumber),
          transactionHash: log.transactionHash || '',
        });

        logger.debug({ ensNameId, tokenId: tokenIdStr, newOwner: to }, 'Published ownership update job');
      } catch (queueError: any) {
        // Don't fail indexing if queue publishing fails
        logger.error({
          errorMessage: queueError?.message || String(queueError),
          errorStack: queueError?.stack,
          ensNameId
        }, 'Failed to publish ownership update job');
      }
    }

    try {
      const block = await this.client.getBlock({ blockNumber: log.blockNumber! });

      const txQuery = `
        INSERT INTO transactions (
          ens_name_id, transaction_hash, block_number,
          from_address, to_address, transaction_type, timestamp
        )
        SELECT id, $2, $3, $4, $5, 'transfer', $6
        FROM ens_names
        WHERE token_id = $1
        ON CONFLICT (transaction_hash) DO NOTHING
      `;

      await this.pool.query(txQuery, [
        tokenIdStr,
        log.transactionHash,
        log.blockNumber?.toString(),
        from.toLowerCase(),
        to.toLowerCase(),
        new Date(Number(block.timestamp) * 1000),
      ]);
    } catch (error: any) {
      logger.error('Failed to insert transaction:', {
        error: error.message,
        tokenId: tokenIdStr,
        transactionHash: log.transactionHash
      });
      // Don't rethrow - we can continue even if transaction insert fails
    }
  }

  private async handleNameRegistered(args: any, log: Log) {
    const { id: tokenId, owner, expires } = args;
    const tokenIdStr = typeof tokenId === 'bigint' ? tokenId.toString() : String(tokenId);

    let block: any;
    try {
      // Try to resolve the actual ENS name
      const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);
      const nameToStore = resolvedData?.name || `token-${tokenIdStr}`; // Fallback to placeholder if not resolved
      const { has_numbers, has_emoji } = this.calculateNameAttributes(nameToStore);

      block = await this.client.getBlock({ blockNumber: log.blockNumber! });
      const expiryDate = new Date(Number(expires) * 1000);

      const upsertQuery = `
        INSERT INTO ens_names (
          token_id, owner_address, registrant,
          expiry_date, registration_date, name, has_numbers, has_emoji
        ) VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (token_id) DO UPDATE SET
          owner_address = EXCLUDED.owner_address,
          registrant = EXCLUDED.registrant,
          expiry_date = EXCLUDED.expiry_date,
          name = CASE
            WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.name
            ELSE ens_names.name
          END,
          has_numbers = CASE
            WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.has_numbers
            ELSE ens_names.has_numbers
          END,
          has_emoji = CASE
            WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.has_emoji
            ELSE ens_names.has_emoji
          END,
          updated_at = NOW()
      `;

      const result = await this.pool.query(upsertQuery + ' RETURNING id', [
        tokenIdStr,
        owner.toLowerCase(),
        expiryDate,
        new Date(Number(block.timestamp) * 1000),
        nameToStore,
        has_numbers,
        has_emoji
      ]);

      // Create mint activity record with the registration date as the event timestamp
      if (result.rows.length > 0) {
        const ensNameId = result.rows[0].id;
        const registrationDate = new Date(Number(block.timestamp) * 1000);

        try {
          await this.pool.query(
            `INSERT INTO activity_history (
              ens_name_id,
              event_type,
              actor_address,
              platform,
              chain_id,
              transaction_hash,
              block_number,
              metadata,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT DO NOTHING`,
            [
              ensNameId,
              'mint',
              owner.toLowerCase(),
              'blockchain',
              1,
              log.transactionHash || null,
              log.blockNumber?.toString() || null,
              JSON.stringify({ token_id: tokenIdStr }),
              registrationDate
            ]
          );
          logger.debug(`Created mint activity for ${nameToStore} (token ${tokenIdStr}) with registration date ${registrationDate.toISOString()}`);
        } catch (activityError: any) {
          logger.error('Failed to create mint activity:', {
            error: activityError.message,
            tokenId: tokenIdStr,
            ensNameId
          });
          // Don't fail the entire registration if activity creation fails
        }
      }
    } catch (error: any) {
      // If we get a unique constraint violation on name, it means the name already exists
      // with a different token_id. This shouldn't happen for NameRegistered events but handle it gracefully.
      if (error.code === '23505' && error.constraint === 'ens_names_real_name_unique') {
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);
        const nameToStore = resolvedData?.name || `token-${tokenIdStr}`;
        logger.warn(`ENS name "${nameToStore}" already exists during NameRegistered event. This indicates a data inconsistency.`);
        // Continue processing - the name already exists in the database
      } else {
        logger.error('Failed to handle NameRegistered:', {
          error: error.message,
          tokenId: tokenIdStr,
          owner
        });
        throw error;
      }
    }

    if (!block) return;

    const txQuery = `
      INSERT INTO transactions (
        ens_name_id, transaction_hash, block_number,
        from_address, to_address, transaction_type, timestamp
      )
      SELECT id, $2, $3, $4, $4, 'registration', $5
      FROM ens_names WHERE token_id = $1
      ON CONFLICT (transaction_hash) DO NOTHING
    `;

    try {
      await this.pool.query(txQuery, [
        tokenIdStr,
        log.transactionHash,
        log.blockNumber?.toString(),
        owner.toLowerCase(),
        new Date(Number(block.timestamp) * 1000),
      ]);
    } catch (error: any) {
      logger.error('Failed to insert registration transaction:', {
        error: error.message,
        tokenId: tokenIdStr
      });
    }
  }

  private async handleNameRenewed(args: any, log: Log) {
    const { id: tokenId, expires } = args;
    const tokenIdStr = typeof tokenId === 'bigint' ? tokenId.toString() : String(tokenId);
    const expiryDate = new Date(Number(expires) * 1000);

    const updateQuery = `
      UPDATE ens_names
      SET expiry_date = $1, updated_at = NOW()
      WHERE token_id = $2
    `;

    await this.pool.query(updateQuery, [expiryDate, tokenIdStr]);

    const block = await this.client.getBlock({ blockNumber: log.blockNumber! });

    const txQuery = `
      INSERT INTO transactions (
        ens_name_id, transaction_hash, block_number,
        from_address, to_address, transaction_type, timestamp
      )
      SELECT id, $2, $3, owner_address, owner_address, 'renewal', $4
      FROM ens_names WHERE token_id = $1
      ON CONFLICT (transaction_hash) DO NOTHING
    `;

    await this.pool.query(txQuery, [
      tokenIdStr,
      log.transactionHash,
      log.blockNumber?.toString(),
      new Date(Number(block.timestamp) * 1000),
    ]);
  }

  private async getLastProcessedBlock(): Promise<number> {
    const query = `
      SELECT last_processed_block FROM indexer_state
      WHERE contract_address = $1
    `;

    const result = await this.pool.query(query, [config.blockchain.ensRegistrarAddress]);
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
      config.blockchain.ensRegistrarAddress,
      blockNumber.toString(),
    ]);
  }
}