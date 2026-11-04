import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * Keeps compromised_names (migration 0895) current:
 *   1. links rows imported before the name existed in ens_names (exact name match only),
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
              AND en.name = cn.name`
        );

        // A flag linked to a row with a different name AND a different token protects nothing
        // (this is how vlad.eth got linked to 'VLAD.eth'). Name-only or token-only matches are
        // fine: unknown labels show up as [labelhash], wrapped names carry a namehash token_id.
        const mislinked = await pool.query(
          `SELECT cn.id, cn.name, en.name AS linked_name
             FROM compromised_names cn
             JOIN ens_names en ON en.id = cn.ens_name_id
            WHERE cn.status = 'active'
              AND en.name <> cn.name
              AND en.token_id IS DISTINCT FROM cn.token_id`
        );
        if (mislinked.rows.length > 0) {
          logger.warn({ mislinked: mislinked.rows }, 'Compromised names linked to the wrong ens_names row');
        }

        const returned = await pool.query(
          `UPDATE compromised_names cn
              SET status = 'resolved', resolved_at = NOW(),
                  resolved_reason = 'returned_to_owner', updated_at = NOW()
             FROM ens_names en
            WHERE cn.status = 'active'
              AND en.id = cn.ens_name_id
              AND (LOWER(en.owner_address) = LOWER(cn.original_owner)
                   OR LOWER(en.owner_address) = ANY(SELECT LOWER(a) FROM unnest(cn.allowed_addresses) a))
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
                   AND LOWER(r.owner_address) IS DISTINCT FROM LOWER(cn.taken_by)
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
