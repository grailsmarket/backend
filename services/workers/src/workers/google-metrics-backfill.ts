import PgBoss from 'pg-boss';
import { getPostgresPool, config, fetchKeywordMetrics, cacheGoogleMetrics } from '../../../shared/src';
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

/** Fraction of each batch dedicated to uncategorized names */
const UNCATEGORIZED_RATIO = 1.0;
/** Per-run slot counts for each pool */
const CATEGORIZED_BATCH = Math.ceil(BATCH_SIZE * (1 - UNCATEGORIZED_RATIO));
const UNCATEGORIZED_BATCH = BATCH_SIZE - CATEGORIZED_BATCH;

/** Consecutive null returns before aborting batch (likely quota/auth issue) */
const MAX_CONSECUTIVE_ERRORS = 3;

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find categorized (club) names that don't have unexpired google_metrics rows.
 * Prioritizes: 999 club > 10k > 100k > others.
 * Skips emoji names, hyphenated names, and subdomain names.
 */
async function getCategorizedCandidates(limit: number): Promise<string[]> {
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
 * Find uncategorized names (not in any club) that don't have unexpired google_metrics rows.
 * Prioritizes by market signals: active offers > recent sales > older sales > engagement.
 * Within tiers, prefers names with views/votes, shorter names, and higher engagement.
 */
async function getUncategorizedCandidates(limit: number): Promise<string[]> {
  const pool = getPostgresPool();
  const result = await pool.query<{ label: string }>(
    `SELECT REPLACE(en.name, '.eth', '') AS label
     FROM ens_names en
     WHERE (en.clubs IS NULL OR array_length(en.clubs, 1) IS NULL OR array_length(en.clubs, 1) = 0)
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
         WHEN en.highest_offer_wei IS NOT NULL THEN 1
         WHEN en.last_sale_date IS NOT NULL AND en.last_sale_date > NOW() - INTERVAL '90 days' THEN 2
         WHEN en.last_sale_date IS NOT NULL THEN 3
         ELSE 4
       END,
       CASE
         WHEN COALESCE(en.view_count, 0) > 0 AND COALESCE(en.net_score, 0) > 0 THEN 1
         WHEN COALESCE(en.view_count, 0) > 0 THEN 2
         WHEN COALESCE(en.net_score, 0) > 0 THEN 3
         ELSE 4
       END,
       LENGTH(REPLACE(en.name, '.eth', '')) ASC,
       COALESCE(en.view_count, 0) + COALESCE(en.net_score, 0) * 3 DESC,
       en.name ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => r.label);
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
      // Fetch both pools in parallel
      const [categorizedNames, uncategorizedNames] = await Promise.all([
        getCategorizedCandidates(CATEGORIZED_BATCH),
        getUncategorizedCandidates(UNCATEGORIZED_BATCH),
      ]);

      // Overflow: if one pool is short, give remaining slots to the other
      let extraCategorized: string[] = [];
      let extraUncategorized: string[] = [];
      const categorizedShortfall = CATEGORIZED_BATCH - categorizedNames.length;
      const uncategorizedShortfall = UNCATEGORIZED_BATCH - uncategorizedNames.length;

      if (uncategorizedShortfall > 0 && CATEGORIZED_BATCH > 0 && categorizedNames.length === CATEGORIZED_BATCH) {
        extraCategorized = await getCategorizedCandidates(uncategorizedShortfall);
      } else if (categorizedShortfall > 0 && uncategorizedNames.length === UNCATEGORIZED_BATCH) {
        extraUncategorized = await getUncategorizedCandidates(categorizedShortfall);
      }

      // Process categorized first (keep club data fresh if batch aborts early)
      const names = [
        ...categorizedNames,
        ...extraCategorized,
        ...uncategorizedNames,
        ...extraUncategorized,
      ];

      const categorizedCount = categorizedNames.length + extraCategorized.length;
      const uncategorizedCount = uncategorizedNames.length + extraUncategorized.length;

      if (names.length === 0) {
        logger.info({ jobId: job.id }, 'No candidate names for backfill — all caught up');
        return { success: true, processed: 0, noData: 0, errors: 0 };
      }

      logger.info(
        { jobId: job.id, batchSize: names.length, categorizedCount, uncategorizedCount, delayMs: DELAY_MS },
        'Starting Google metrics backfill batch',
      );

      let processed = 0;
      let noData = 0;
      let preserved = 0;
      let errors = 0;
      let consecutiveErrors = 0;

      for (const name of names) {
        // Delay between calls (skip delay before the first call)
        if (processed > 0 || noData > 0 || preserved > 0 || errors > 0) {
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
                { jobId: job.id, consecutiveErrors, processed, noData, preserved, errors },
                'Aborting batch — too many consecutive errors (likely quota or auth issue)',
              );
              break;
            }
            continue;
          }

          // Reset consecutive error counter on any successful API call
          consecutiveErrors = 0;

          const result = await cacheGoogleMetrics(name, metrics, ONE_YEAR_MS);
          if (result.status === 'success') {
            processed++;
          } else if (result.written) {
            noData++;
          } else {
            // Empty Google response, but existing success row protected from overwrite
            preserved++;
            logger.info({ name }, 'Skipped overwriting cached metrics with empty Google response');
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
        { jobId: job.id, processed, noData, preserved, errors, total: names.length, categorizedCount, uncategorizedCount },
        'Google metrics backfill batch completed',
      );

      return { success: true, processed, noData, preserved, errors };
    },
  );

  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, { tz: 'UTC' });

  logger.info(
    { queue: QUEUE_NAME, schedule: CRON_SCHEDULE, batchSize: BATCH_SIZE, delayMs: DELAY_MS },
    'Google metrics backfill worker registered',
  );
}
