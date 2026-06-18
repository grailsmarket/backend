import PgBoss from 'pg-boss';
import { getPostgresPool, deleteFile, isStorageEnabled } from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * ALL-chats image expiry: delete chat images older than the configured cutoff
 * (default 180 days, admin-tunable via global_chat_config.image_retention_days)
 * from the bucket and stamp `expired_at`. The message itself is kept intact —
 * the serving route then returns 410 and the UI shows "image expired".
 *
 * Iterates with a keyset cursor on (created_at, id) so a persistently failing
 * delete can't wedge the run in an infinite loop: failed rows keep expired_at
 * NULL and are retried on the next scheduled run.
 */

const QUEUE_NAME = 'expire-chat-images';
const CRON_SCHEDULE = '0 5 * * *'; // daily, 5 AM UTC
const DEFAULT_RETENTION_DAYS = 180;
const BATCH_SIZE = 500;

async function getImageRetentionDays(pool: ReturnType<typeof getPostgresPool>): Promise<number> {
  const r = await pool.query(`SELECT image_retention_days FROM global_chat_config WHERE id = 1`);
  const v = Number(r.rows[0]?.image_retention_days);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETENTION_DAYS;
}

export async function registerExpireChatImagesWorker(boss: PgBoss) {
  await boss.work(
    QUEUE_NAME,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      logger.info({ jobId: job.id }, 'Starting chat image expiry');
      try {
        if (!isStorageEnabled()) {
          logger.warn({ jobId: job.id }, 'Storage not configured; skipping chat image expiry');
          return { success: true, expired: 0, skipped: true };
        }

        const pool = getPostgresPool();
        const days = await getImageRetentionDays(pool);

        let expired = 0;
        let failed = 0;
        let lastCreated: string | null = null;
        let lastId: string | null = null;

        for (;;) {
          const params: unknown[] = [days, BATCH_SIZE];
          let cursorClause = '';
          if (lastCreated !== null && lastId !== null) {
            params.push(lastCreated, lastId);
            cursorClause = `AND (created_at, id) > ($3, $4)`;
          }
          const batch = await pool.query<{ id: string; storage_key: string; created_at: string }>(
            `SELECT id, storage_key, created_at FROM message_attachments
              WHERE expired_at IS NULL
                AND created_at < NOW() - make_interval(days => $1::int)
                ${cursorClause}
              ORDER BY created_at, id
              LIMIT $2`,
            params
          );
          if (batch.rows.length === 0) break;

          for (const a of batch.rows) {
            try {
              await deleteFile(a.storage_key);
              await pool.query(`UPDATE message_attachments SET expired_at = NOW() WHERE id = $1`, [a.id]);
              expired += 1;
            } catch (err) {
              failed += 1;
              logger.error({ err, key: a.storage_key }, 'Failed to expire chat image; will retry next run');
            }
          }

          // Advance the cursor regardless of per-row success → guaranteed progress.
          const last = batch.rows[batch.rows.length - 1];
          lastCreated = last.created_at;
          lastId = last.id;

          if (batch.rows.length < BATCH_SIZE) break;
        }

        logger.info({ jobId: job.id, days, expired, failed }, 'Chat image expiry completed');
        return { success: true, expired, failed };
      } catch (error) {
        logger.error({ jobId: job.id, err: error }, 'Chat image expiry failed');
        throw error;
      }
    }
  );

  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, { tz: 'UTC' });

  logger.info(
    { queue: QUEUE_NAME, schedule: CRON_SCHEDULE },
    'Chat image expiry worker registered (daily, 5 AM UTC)'
  );
}
