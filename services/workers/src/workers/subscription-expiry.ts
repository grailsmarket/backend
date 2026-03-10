import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'batch-expire-subscriptions';

/**
 * Subscription Expiry Worker
 *
 * Runs every 15 minutes. Finds active subscriptions that have expired
 * and downgrades users back to the free tier.
 */
export async function registerSubscriptionExpiryWorker(boss: PgBoss): Promise<void> {
  await boss.schedule(QUEUE_NAME, '*/15 * * * *');

  await boss.work(QUEUE_NAME, async () => {
    logger.info('Running subscription expiry check');

    const pool = getPostgresPool();

    try {
      // Find and expire overdue subscriptions
      const expiredResult = await pool.query(
        `UPDATE user_subscriptions
         SET status = 'expired', updated_at = NOW()
         WHERE status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at <= NOW()
         RETURNING id, user_id`
      );

      if (expiredResult.rows.length === 0) {
        logger.debug('Subscription expiry check completed - no expired subscriptions');
        return;
      }

      logger.info(
        { count: expiredResult.rows.length },
        'Expired subscriptions found'
      );

      // Collect unique user IDs
      const userIds = [...new Set(expiredResult.rows.map((r: any) => r.user_id))];

      // Downgrade users who have no remaining active subscriptions
      for (const userId of userIds) {
        // Check if user has any other active (non-expired) subscription
        const activeCheck = await pool.query(
          `SELECT id FROM user_subscriptions
           WHERE user_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
           LIMIT 1`,
          [userId]
        );

        if (activeCheck.rows.length === 0) {
          await pool.query(
            `UPDATE users SET tier = 'free', tier_expires_at = NULL WHERE id = $1`,
            [userId]
          );
          logger.info({ userId }, 'User downgraded to free tier');
        }
      }

      logger.info(
        { expiredCount: expiredResult.rows.length, usersChecked: userIds.length },
        'Subscription expiry check completed'
      );
    } catch (error) {
      logger.error({ error }, 'Error in subscription expiry job');
      throw error;
    }
  });

  logger.info('Subscription expiry worker registered (runs every 15 minutes)');
}
