import { createPublicClient, http, parseAbiItem, type Log, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { config, getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const SUBSCRIBED_EVENT = parseAbiItem(
  'event Subscribed(address indexed subscriber, uint256 expiry, uint256 amount)'
);

/**
 * Listens for Subscribed events from the GrailsSubscription contract.
 * Uses a stateless getLogs() polling loop (same pattern as SeaportIndexer)
 * to avoid the "filter not found" error from watchEvent().
 *
 * On detection:
 *   1. Upsert user by address
 *   2. Insert user_subscriptions row
 *   3. Update users.tier and users.tier_expires_at
 */
export class SubscriptionListener {
  private client: PublicClient;
  private pool = getPostgresPool();
  private isRunning = false;
  private currentBlock = 0n;
  private readonly batchSize = 100;
  private readonly confirmations = BigInt(config.blockchain.confirmations);
  private readonly pollIntervalMs = 12000;
  private readonly errorRetryMs = 5000;

  constructor() {
    this.client = createPublicClient({
      chain: mainnet,
      transport: http(config.blockchain.rpcUrl),
    });
  }

  async start() {
    const contractAddress = config.subscription.contractAddress;
    if (!contractAddress) {
      logger.warn('SUBSCRIPTION_CONTRACT_ADDRESS not configured, skipping subscription listener');
      return;
    }

    this.isRunning = true;

    const lastBlock = await this.getLastProcessedBlock();
    const startBlock = lastBlock > 0
      ? BigInt(lastBlock) + 1n
      : BigInt(config.blockchain.startBlock || 19000000);

    this.currentBlock = startBlock;
    logger.info(`Subscription listener starting from block ${this.currentBlock}`);

    this.pollLoop();
  }

  async stop() {
    this.isRunning = false;
    logger.info('Subscription listener stopped');
  }

  private async pollLoop() {
    const contractAddress = config.subscription.contractAddress as `0x${string}`;

    while (this.isRunning) {
      try {
        const latestBlock = await this.client.getBlockNumber();
        const targetBlock = latestBlock - this.confirmations;

        if (this.currentBlock > targetBlock) {
          await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
          continue;
        }

        const toBlock = this.currentBlock + BigInt(this.batchSize) - 1n;
        const actualToBlock = toBlock > targetBlock ? targetBlock : toBlock;

        await this.fetchAndProcessLogs(contractAddress, this.currentBlock, actualToBlock);
        await this.updateLastProcessedBlock(actualToBlock);

        this.currentBlock = actualToBlock + 1n;
      } catch (error: any) {
        logger.error(`Error in subscription poll loop at block ${this.currentBlock}:`, {
          error: error.message,
          code: error.code,
          details: error.shortMessage || error.details,
        });
        await new Promise(resolve => setTimeout(resolve, this.errorRetryMs));
      }
    }
  }

  private async fetchAndProcessLogs(address: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
    logger.info(`Fetching subscription events from block ${fromBlock} to ${toBlock}`);

    const logs = await this.client.getLogs({
      address,
      event: SUBSCRIBED_EVENT,
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
      try {
        await this.handleSubscribedEvent(log);
      } catch (err) {
        logger.error({ error: err, log }, 'Error handling Subscribed event');
      }
    }
  }

  private async getLastProcessedBlock(): Promise<number> {
    const query = `
      SELECT last_processed_block FROM indexer_state
      WHERE contract_address = $1
    `;
    const result = await this.pool.query(query, [config.subscription.contractAddress]);
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
      config.subscription.contractAddress,
      blockNumber.toString(),
    ]);
  }

  private async handleSubscribedEvent(log: Log) {
    const args = (log as any).args;
    if (!args) {
      logger.warn({ log }, 'Subscribed event missing args');
      return;
    }

    const subscriber = (args.subscriber as string).toLowerCase();
    const expiry = Number(args.expiry);
    const amount = (args.amount as bigint).toString();
    const txHash = log.transactionHash;

    logger.info({ subscriber, expiry, amount, txHash }, 'Processing Subscribed event');

    const expiresAt = new Date(expiry * 1000);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert user
      const userResult = await client.query(
        `INSERT INTO users (address) VALUES ($1)
         ON CONFLICT (address) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [subscriber]
      );
      const userId = userResult.rows[0].id;

      // Insert subscription record
      await client.query(
        `INSERT INTO user_subscriptions
         (user_id, tier, status, started_at, expires_at, payment_method, payment_tx_hash, payment_amount_wei)
         VALUES ($1, 'pro', 'active', NOW(), $2, 'contract', $3, $4)`,
        [userId, expiresAt, txHash, amount]
      );

      // Update denormalized user fields — use the latest expiry
      await client.query(
        `UPDATE users
         SET tier = 'pro',
             tier_expires_at = GREATEST(COALESCE(tier_expires_at, $2), $2)
         WHERE id = $1`,
        [userId, expiresAt]
      );

      await client.query('COMMIT');

      logger.info({ userId, subscriber, expiresAt, txHash }, 'Subscription recorded successfully');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
