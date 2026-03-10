import { createPublicClient, http, parseAbiItem, type Log } from 'viem';
import { mainnet } from 'viem/chains';
import { config, getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const SUBSCRIBED_EVENT = parseAbiItem(
  'event Subscribed(address indexed subscriber, uint256 expiry, uint256 amount)'
);

/**
 * Listens for Subscribed events from the GrailsSubscription contract.
 * On detection:
 *   1. Upsert user by address
 *   2. Insert user_subscriptions row
 *   3. Update users.tier and users.tier_expires_at
 */
export class SubscriptionListener {
  private client;
  private pool = getPostgresPool();
  private unwatch: (() => void) | null = null;

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

    logger.info({ contractAddress }, 'Starting subscription event listener');

    this.unwatch = this.client.watchEvent({
      address: contractAddress as `0x${string}`,
      event: SUBSCRIBED_EVENT,
      onLogs: (logs) => {
        for (const log of logs) {
          this.handleSubscribedEvent(log).catch((err) => {
            logger.error({ error: err, log }, 'Error handling Subscribed event');
          });
        }
      },
      onError: (error) => {
        logger.error({ error }, 'Subscription event watcher error');
      },
    });

    logger.info('Subscription event listener started');
  }

  async stop() {
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
      logger.info('Subscription event listener stopped');
    }
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
