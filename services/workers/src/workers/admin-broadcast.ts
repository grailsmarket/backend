import PgBoss from 'pg-boss';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, type SendAdminBroadcastJob } from '../queue';
import { sendEmail, buildAdminBroadcastEmail } from '../services/email';

const FRONTEND_URL = config.frontend.url;

/**
 * Admin broadcast worker — per-recipient delivery of an admin-authored
 * notification. Delivers to in-app and email channels; telegram is accepted
 * in the payload but silently skipped (no telegram infrastructure on this
 * deployment yet).
 */
export async function registerAdminBroadcastWorker(boss: PgBoss): Promise<void> {
  await boss.work<SendAdminBroadcastJob>(
    QUEUE_NAMES.SEND_ADMIN_BROADCAST,
    { teamSize: 5, teamConcurrency: 2 },
    async (job) => {
      const { broadcastId, userId, channels, title, body, linkUrl, imageUrl } = job.data;

      const pool = getPostgresPool();

      const broadcastResult = await pool.query(
        'SELECT id FROM admin_broadcasts WHERE id = $1',
        [broadcastId]
      );
      if (broadcastResult.rows.length === 0) {
        logger.warn({ broadcastId }, 'Admin broadcast not found, skipping');
        return;
      }

      const userResult = await pool.query(
        `SELECT id, email, email_verified FROM users WHERE id = $1`,
        [userId]
      );
      if (userResult.rows.length === 0) {
        logger.warn({ userId, broadcastId }, 'User not found for admin broadcast');
        return;
      }
      const user = userResult.rows[0];

      const unsubscribeUrl = `${FRONTEND_URL}/settings/notifications`;

      if (channels.includes('in_app')) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
           VALUES ($1, 'admin-broadcast', NULL, $2, NOW())`,
          [userId, JSON.stringify({ title, body, linkUrl, imageUrl, broadcastId })]
        );
      }

      if (channels.includes('email') && user.email_verified && user.email) {
        try {
          const template = buildAdminBroadcastEmail({ title, body, linkUrl, imageUrl, unsubscribeUrl });
          await sendEmail(user.email, template);
        } catch (error) {
          logger.error({ error, userId, broadcastId }, 'Failed to send admin broadcast email');
          throw error;
        }
      }

      logger.info({ userId, broadcastId, channels }, 'Admin broadcast delivered');
    }
  );

  logger.info('Admin broadcast worker registered');
}
