import PgBoss from 'pg-boss';
import { getPostgresPool, config, fetchKeywordMetrics, KeywordMetricsResponse } from '../../../shared/src';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'backfill-google-metrics';
const CRON_SCHEDULE = '*/10 * * * *'; // Every 10 minutes

/** Max API calls per day allocated to backfill */
const DAILY_QUOTA = parseInt(process.env.GOOGLE_METRICS_DAILY_QUOTA || '10000');
/** Delay between individual API calls (ms) */
const DELAY_MS = parseInt(process.env.GOOGLE_METRICS_DELAY_MS || '8700');
/** Kill switch */
const ENABLED = process.env.GOOGLE_METRICS_ENABLED !== 'false';

/** Runs per day: 144 (every 10 min). Batch size = quota / runs. */
const BATCH_SIZE = Math.floor(DAILY_QUOTA / 144);

/** Consecutive null returns before aborting batch (likely quota/auth issue) */
const MAX_CONSECUTIVE_ERRORS = 3;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if a metrics response has real data or is effectively empty.
 * Google returns an object with all-null fields for unknown/profane keywords.
 */
function hasRealData(metrics: KeywordMetricsResponse): boolean {
  return (
    metrics.avgMonthlySearches !== null ||
    metrics.avgCpc !== null ||
    metrics.competition !== null ||
    metrics.monthlyTrend.length > 0
  );
}

/**
 * Find club names that don't have unexpired google_metrics rows.
 * Prioritizes: 999 club > 10k > 100k > others.
 * Skips emoji names, hyphenated names, and subdomain names.
 */
async function getCandidateNames(limit: number): Promise<string[]> {
  const pool = getPostgresPool();
  const result = await pool.query<{ label: string }>(
    `SELECT REPLACE(en.name, '.eth', '') AS label
     FROM ens_names en
     WHERE en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0
       AND (en.has_emoji IS NULL OR en.has_emoji = false)
       AND en.name NOT LIKE '%-%'
       AND en.name NOT LIKE '%.%.eth'
       AND NOT EXISTS (
         SELECT 1 FROM google_metrics gm
         WHERE gm.name = REPLACE(en.name, '.eth', '')
           AND gm.expires_at > NOW()
       )
     ORDER BY
       CASE
         WHEN '999' = ANY(en.clubs) THEN 1
         WHEN '10k' = ANY(en.clubs) THEN 2
         WHEN '100k' = ANY(en.clubs) THEN 3
         ELSE 4
       END,
       en.name ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => r.label);
}

/**
 * Upsert a google_metrics row with the given status and appropriate TTL.
 */
async function upsertMetrics(
  name: string,
  metrics: KeywordMetricsResponse | Record<string, never>,
  status: 'success' | 'no_data',
): Promise<void> {
  const pool = getPostgresPool();
  const ttlMs = status === 'success' ? THIRTY_DAYS_MS : NINETY_DAYS_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  await pool.query(
    `INSERT INTO google_metrics (name, metrics, status, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (name)
     DO UPDATE SET
       metrics = EXCLUDED.metrics,
       status = EXCLUDED.status,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [name, JSON.stringify(metrics), status, expiresAt],
  );
}

export async function registerGoogleMetricsBackfillWorker(boss: PgBoss) {
  // Kill switch
  if (!ENABLED) {
    logger.warn('Google metrics backfill worker disabled (GOOGLE_METRICS_ENABLED=false)');
    return;
  }

  // Credential check
  const { developerToken, clientId, clientSecret, refreshToken, customerId } = config.googleAds;
  if (!developerToken || !clientId || !clientSecret || !refreshToken || !customerId) {
    logger.warn('Google metrics backfill worker skipped — missing Google Ads credentials');
    return;
  }

  await boss.work(
    QUEUE_NAME,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      logger.info(
        { jobId: job.id, batchSize: BATCH_SIZE, delayMs: DELAY_MS },
        'Starting Google metrics backfill batch',
      );

      const names = await getCandidateNames(BATCH_SIZE);

      if (names.length === 0) {
        logger.info({ jobId: job.id }, 'No candidate names for backfill — all caught up');
        return { success: true, processed: 0, noData: 0, errors: 0 };
      }

      let processed = 0;
      let noData = 0;
      let errors = 0;
      let consecutiveErrors = 0;

      for (const name of names) {
        // Delay between calls (skip delay before the first call)
        if (processed > 0 || noData > 0 || errors > 0) {
          await sleep(DELAY_MS);
        }

        try {
          const metrics = await fetchKeywordMetrics(name);

          if (metrics === null) {
            // Transient error (network, creds, quota)
            errors++;
            consecutiveErrors++;
            logger.warn({ name, consecutiveErrors }, 'Google metrics fetch returned null');

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              logger.error(
                { jobId: job.id, consecutiveErrors, processed, noData, errors },
                'Aborting batch — too many consecutive errors (likely quota or auth issue)',
              );
              break;
            }
            continue;
          }

          // Reset consecutive error counter on any successful API call
          consecutiveErrors = 0;

          if (hasRealData(metrics)) {
            await upsertMetrics(name, metrics, 'success');
            processed++;
          } else {
            await upsertMetrics(name, {}, 'no_data');
            noData++;
          }
        } catch (error) {
          errors++;
          consecutiveErrors++;
          logger.error({ name, err: error }, 'Unexpected error processing name');

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            logger.error(
              { jobId: job.id, consecutiveErrors },
              'Aborting batch — too many consecutive errors',
            );
            break;
          }
        }
      }

      logger.info(
        { jobId: job.id, processed, noData, errors, total: names.length },
        'Google metrics backfill batch completed',
      );

      return { success: true, processed, noData, errors };
    },
  );

  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, { tz: 'UTC' });

  logger.info(
    { queue: QUEUE_NAME, schedule: CRON_SCHEDULE, batchSize: BATCH_SIZE, delayMs: DELAY_MS },
    'Google metrics backfill worker registered',
  );
}
