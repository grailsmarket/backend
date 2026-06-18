import PgBoss from 'pg-boss';
import { getPostgresPool, deleteFile, isStorageEnabled, GLOBAL_CHAT_ID } from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * GLOBAL chat retention cap: hard-delete global messages older than the
 * configured cutoff (default 30 days, admin-tunable via global_chat_config).
 * Any attached images are removed from the bucket first — ON DELETE CASCADE
 * would otherwise drop the message_attachments rows that hold the storage keys,
 * orphaning the objects. Applies to the global room only; DMs/groups keep all
 * messages (their images expire separately via expire-chat-images.ts).
 */

const QUEUE_NAME = 'cleanup-global-chat-messages';
const CRON_SCHEDULE = '0 4 * * *'; // daily, 4 AM UTC
const DEFAULT_RETENTION_DAYS = 30;
const BATCH_SIZE = 500;

async function getRetentionDays(pool: ReturnType<typeof getPostgresPool>): Promise<number> {
  const r = await pool.query(`SELECT message_retention_days FROM global_chat_config WHERE id = 1`);
  const v = Number(r.rows[0]?.message_retention_days);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETENTION_DAYS;
}

export async function registerGlobalChatRetentionWorker(boss: PgBoss) {
  await boss.work(
    QUEUE_NAME,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      logger.info({ jobId: job.id }, 'Starting global chat retention cleanup');
      try {
        const pool = getPostgresPool();
        const days = await getRetentionDays(pool);

        let deletedMessages = 0;
        let deletedImages = 0;

        // Batch loop: each round finds a slice of expired global messages, pulls
        // their bucket images, then hard-deletes the rows. Deleting the rows
        // every round guarantees forward progress (the expired set shrinks).
        for (;;) {
          const batch = await pool.query<{ id: string }>(
            `SELECT id FROM messages
              WHERE chat_id = $1
                AND created_at < NOW() - make_interval(days => $2::int)
              ORDER BY created_at
              LIMIT $3`,
            [GLOBAL_CHAT_ID, days, BATCH_SIZE]
          );
          if (batch.rows.length === 0) break;
          const ids = batch.rows.map((r) => r.id);

          if (isStorageEnabled()) {
            const atts = await pool.query<{ storage_key: string }>(
              `SELECT storage_key FROM message_attachments
                WHERE message_id = ANY($1::uuid[]) AND expired_at IS NULL`,
              [ids]
            );
            for (const a of atts.rows) {
              try {
                await deleteFile(a.storage_key);
                deletedImages += 1;
              } catch (err) {
                // Object will be orphaned in the bucket; surface for reconciliation.
                logger.error({ err, key: a.storage_key }, 'Failed to delete chat image during retention cleanup');
              }
            }
          }

          const del = await pool.query(`DELETE FROM messages WHERE id = ANY($1::uuid[])`, [ids]);
          deletedMessages += del.rowCount ?? 0;

          if (batch.rows.length < BATCH_SIZE) break;
        }

        logger.info(
          { jobId: job.id, days, deletedMessages, deletedImages },
          'Global chat retention cleanup completed'
        );
        return { success: true, deletedMessages, deletedImages };
      } catch (error) {
        logger.error({ jobId: job.id, err: error }, 'Global chat retention cleanup failed');
        throw error;
      }
    }
  );

  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, { tz: 'UTC' });

  logger.info(
    { queue: QUEUE_NAME, schedule: CRON_SCHEDULE },
    'Global chat retention worker registered (daily, 4 AM UTC)'
  );
}
