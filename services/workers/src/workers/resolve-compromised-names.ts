import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * Keeps compromised_names (migration 0895) current:
 *   1. links rows imported before the name existed in ens_names,
 *   2. resolves a flag when the name is back with the original owner or a recovery wallet,
 *   3. resolves a flag when the name was registered again after it was taken (it expired past
 *      grace and someone new registered it — ens_names.registration_date is COALESCE'd so we read
 *      the registrations log instead). A re-registration by the taker itself does not count.
 */

const QUEUE_NAME = 'resolve-compromised-names';
const CRON_SCHEDULE = '*/30 * * * *'; // every 30 minutes

export async function registerResolveCompromisedNamesWorker(boss: PgBoss) {
  await boss.work(
    QUEUE_NAME,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      const pool = getPostgresPool();
      try {
        const linked = await pool.query(
          `UPDATE compromised_names cn
              SET ens_name_id = en.id, updated_at = NOW()
             FROM ens_names en
            WHERE cn.ens_name_id IS NULL
              AND LOWER(en.name) = cn.name`
        );

        const returned = await pool.query(
          `UPDATE compromised_names cn
              SET status = 'resolved', resolved_at = NOW(),
                  resolved_reason = 'returned_to_owner', updated_at = NOW()
             FROM ens_names en
            WHERE cn.status = 'active'
              AND en.id = cn.ens_name_id
              AND (LOWER(en.owner_address) = cn.original_owner
                   OR LOWER(en.owner_address) = ANY(cn.allowed_addresses))
            RETURNING cn.name`
        );

        const reregistered = await pool.query(
          `UPDATE compromised_names cn
              SET status = 'resolved', resolved_at = NOW(),
                  resolved_reason = 'reregistered', updated_at = NOW()
            WHERE cn.status = 'active'
              AND cn.taken_at IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM registrations r
                 WHERE r.ens_name_id = cn.ens_name_id
                   AND r.registration_date > cn.taken_at
                   AND LOWER(r.owner_address) IS DISTINCT FROM cn.taken_by
              )
            RETURNING cn.name`
        );

        logger.info(
          {
            jobId: job.id,
            linked: linked.rowCount ?? 0,
            returned: returned.rows.map((r) => r.name),
            reregistered: reregistered.rows.map((r) => r.name),
          },
          'Compromised names resolution pass completed'
        );
        return {
          success: true,
          linked: linked.rowCount ?? 0,
          returned: returned.rowCount ?? 0,
          reregistered: reregistered.rowCount ?? 0,
        };
      } catch (error) {
        logger.error({ jobId: job.id, err: error }, 'Compromised names resolution failed');
        throw error;
      }
    }
  );

  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, { tz: 'UTC' });

  logger.info({ queue: QUEUE_NAME, schedule: CRON_SCHEDULE }, 'Compromised names resolution worker registered');
}
