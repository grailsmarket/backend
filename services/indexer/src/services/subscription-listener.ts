import { createPublicClient, http, parseAbiItem, type Log, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { config, getPostgresPool, tierIdToName } from '../../../shared/src';
import { logger } from '../utils/logger';

const SUBSCRIBED_EVENT = parseAbiItem(
  'event Subscribed(address indexed subscriber, uint256 indexed tierId, uint256 expiry, uint256 amount)'
);

const UPGRADED_EVENT = parseAbiItem(
  'event Upgraded(address indexed subscriber, uint256 indexed oldTierId, uint256 indexed newTierId, uint256 expiry, uint256 amount)'
);

/**
 * Listens for Subscribed and Upgraded events from the GrailsSubscription contract.
 * Uses a stateless getLogs() polling loop (same pattern as SeaportIndexer)
 * to avoid the "filter not found" error from watchEvent().
 *
 * On Subscribed:
 *   1. Upsert user by address
 *   2. Insert user_subscriptions row with tier_id
 *   3. Update users.tier, users.tier_id, and users.tier_expires_at
 *
 * On Upgraded:
 *   1. Upsert user by address
 *   2. Mark old active subscription as superseded
 *   3. Insert new user_subscriptions row with new tier
 *   4. Update users denormalized tier fields
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

    const [subscribedLogs, upgradedLogs] = await Promise.all([
      this.client.getLogs({ address, event: SUBSCRIBED_EVENT, fromBlock, toBlock }),
      this.client.getLogs({ address, event: UPGRADED_EVENT, fromBlock, toBlock }),
    ]);

    // Merge and sort by block number + log index for correct ordering
    const allLogs = [
      ...subscribedLogs.map(l => ({ ...l, eventType: 'subscribed' as const })),
      ...upgradedLogs.map(l => ({ ...l, eventType: 'upgraded' as const })),
    ].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return Number(a.blockNumber! - b.blockNumber!);
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    for (const log of allLogs) {
      try {
        if (log.eventType === 'subscribed') {
          await this.handleSubscribedEvent(log);
        } else {
          await this.handleUpgradedEvent(log);
        }
      } catch (err) {
        logger.error({ error: err, log }, `Error handling ${log.eventType} event`);
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
    const tierId = Number(args.tierId);
    const tierName = tierIdToName(tierId);
    const expiry = Number(args.expiry);
    const amount = (args.amount as bigint).toString();
    const txHash = log.transactionHash;

    logger.info({ subscriber, tierId, tierName, expiry, amount, txHash }, 'Processing Subscribed event');

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
         (user_id, tier, tier_id, status, started_at, expires_at, payment_method, payment_tx_hash, payment_amount_wei)
         VALUES ($1, $2, $3, 'active', NOW(), $4, 'contract', $5, $6)`,
        [userId, tierName, tierId, expiresAt, txHash, amount]
      );

      // Update denormalized user fields — use the latest expiry
      await client.query(
        `UPDATE users
         SET tier = $2,
             tier_id = $3,
             tier_expires_at = GREATEST(COALESCE(tier_expires_at, $4), $4)
         WHERE id = $1`,
        [userId, tierName, tierId, expiresAt]
      );

      await client.query('COMMIT');

      logger.info({ userId, subscriber, tierId, tierName, expiresAt, txHash }, 'Subscription recorded successfully');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async handleUpgradedEvent(log: Log) {
    const args = (log as any).args;
    if (!args) {
      logger.warn({ log }, 'Upgraded event missing args');
      return;
    }

    const subscriber = (args.subscriber as string).toLowerCase();
    const oldTierId = Number(args.oldTierId);
    const newTierId = Number(args.newTierId);
    const newTierName = tierIdToName(newTierId);
    const expiry = Number(args.expiry);
    const amount = (args.amount as bigint).toString();
    const txHash = log.transactionHash;

    logger.info(
      { subscriber, oldTierId, newTierId, newTierName, expiry, amount, txHash },
      'Processing Upgraded event'
    );

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

      // Mark old active subscription(s) as superseded
      await client.query(
        `UPDATE user_subscriptions
         SET status = 'superseded', updated_at = NOW()
         WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );

      // Insert new subscription record for the upgraded tier
      await client.query(
        `INSERT INTO user_subscriptions
         (user_id, tier, tier_id, status, started_at, expires_at, payment_method, payment_tx_hash, payment_amount_wei)
         VALUES ($1, $2, $3, 'active', NOW(), $4, 'contract', $5, $6)`,
        [userId, newTierName, newTierId, expiresAt, txHash, amount]
      );

      // Update denormalized user fields
      await client.query(
        `UPDATE users
         SET tier = $2,
             tier_id = $3,
             tier_expires_at = $4
         WHERE id = $1`,
        [userId, newTierName, newTierId, expiresAt]
      );

      await client.query('COMMIT');

      logger.info(
        { userId, subscriber, oldTierId, newTierId, newTierName, expiresAt, txHash },
        'Subscription upgrade recorded successfully'
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
