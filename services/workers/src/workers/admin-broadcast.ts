import PgBoss from 'pg-boss';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, type SendAdminBroadcastJob } from '../queue';
import { sendEmail, buildAdminBroadcastEmail } from '../services/email';
import { sendTelegramMessage, buildAdminBroadcastTelegram } from '../services/telegram';

const FRONTEND_URL = config.frontend.url;

/**
 * Admin broadcast worker — fan-out per-recipient delivery of an admin-authored
 * notification to paid subscribers. Tier is re-checked at send time because
 * the recipient may have churned between enqueue and processing.
 */
export async function registerAdminBroadcastWorker(boss: PgBoss): Promise<void> {
  await boss.work<SendAdminBroadcastJob>(
    QUEUE_NAMES.SEND_ADMIN_BROADCAST,
    { teamSize: 5, teamConcurrency: 2 },
    async (job) => {
      const { broadcastId, userId, channels, title, body, linkUrl } = job.data;

      const pool = getPostgresPool();

      const broadcastResult = await pool.query(
        'SELECT min_tier_id, is_test FROM admin_broadcasts WHERE id = $1',
        [broadcastId]
      );
      if (broadcastResult.rows.length === 0) {
        logger.warn({ broadcastId }, 'Admin broadcast not found, skipping');
        return;
      }
      const { min_tier_id: minTierId, is_test: isTest } = broadcastResult.rows[0];

      const userResult = await pool.query(
        `SELECT id, email, email_verified, telegram_connected, telegram_chat_id,
                tier_id, tier_expires_at
         FROM users WHERE id = $1`,
        [userId]
      );
      if (userResult.rows.length === 0) {
        logger.warn({ userId, broadcastId }, 'User not found for admin broadcast');
        return;
      }
      const user = userResult.rows[0];

      if (!isTest) {
        const userTierId = user.tier_id ?? 0;
        const notExpired = !user.tier_expires_at || new Date(user.tier_expires_at) > new Date();
        if (userTierId < minTierId || !notExpired) {
          logger.info(
            { userId, userTierId, minTierId, broadcastId },
            'User no longer meets tier floor at send time, skipping'
          );
          return;
        }
      }

      const unsubscribeUrl = `${FRONTEND_URL}/settings/notifications`;

      if (channels.includes('in_app')) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
           VALUES ($1, 'admin-broadcast', NULL, $2, NOW())`,
          [userId, JSON.stringify({ title, body, linkUrl, broadcastId })]
        );
      }

      if (channels.includes('email') && user.email_verified && user.email) {
        try {
          const template = buildAdminBroadcastEmail({ title, body, linkUrl, unsubscribeUrl });
          await sendEmail(user.email, template);
        } catch (error) {
          logger.error({ error, userId, broadcastId }, 'Failed to send admin broadcast email');
          throw error;
        }
      }

      if (channels.includes('telegram') && user.telegram_connected && user.telegram_chat_id) {
        try {
          const text = buildAdminBroadcastTelegram({ title, body, linkUrl });
          await sendTelegramMessage({ chatId: Number(user.telegram_chat_id), text });
        } catch (error) {
          logger.error({ error, userId, broadcastId }, 'Failed to send admin broadcast telegram');
          throw error;
        }
      }

      logger.info({ userId, broadcastId, channels }, 'Admin broadcast delivered');
    }
  );

  logger.info('Admin broadcast worker registered');
}
