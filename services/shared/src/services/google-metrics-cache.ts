import { getPostgresPool } from '../db/client';
import { KeywordMetricsResponse, hasRealData } from './google-ads';

export type GoogleMetricsCacheStatus = 'success' | 'no_data';

export interface CacheGoogleMetricsResult {
  written: boolean;
  status: GoogleMetricsCacheStatus;
}

/**
 * Upsert a google_metrics row.
 *
 * - `success` (Google returned real data): always overwrites.
 * - `no_data` (all-null response): inserts if missing, but will NOT overwrite an
 *   existing `status='success'` row. This protects last-known-good metrics from
 *   being clobbered by a flaky/empty Google response.
 */
export async function cacheGoogleMetrics(
  name: string,
  metrics: KeywordMetricsResponse,
  ttlMs: number,
): Promise<CacheGoogleMetricsResult> {
  const pool = getPostgresPool();
  const expiresAt = new Date(Date.now() + ttlMs);
  const status: GoogleMetricsCacheStatus = hasRealData(metrics) ? 'success' : 'no_data';

  if (status === 'success') {
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
    return { written: true, status };
  }

  const result = await pool.query(
    `INSERT INTO google_metrics (name, metrics, status, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (name)
     DO UPDATE SET
       metrics = EXCLUDED.metrics,
       status = EXCLUDED.status,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()
     WHERE google_metrics.status IS DISTINCT FROM 'success'`,
    [name, JSON.stringify({}), status, expiresAt],
  );
  return { written: (result.rowCount ?? 0) > 0, status };
}
