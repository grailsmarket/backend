import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const pool = getPostgresPool();

/**
 * Track a view of a published dashboard.
 * Fire-and-forget: never throws, returns false on error or duplicate.
 * Skips owner self-views so view_count reflects "views by others".
 */
export async function trackDashboardView(
  dashboardId: number,
  viewerIdentifier: string,
  viewerType: 'authenticated' | 'anonymous',
  ownerUserId: number
): Promise<boolean> {
  if (viewerType === 'authenticated' && viewerIdentifier === `user:${ownerUserId}`) {
    return false;
  }

  try {
    const result = await pool.query(
      `INSERT INTO dashboard_views (dashboard_id, viewer_identifier, viewer_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (dashboard_id, viewer_identifier) DO NOTHING
       RETURNING id`,
      [dashboardId, viewerIdentifier, viewerType]
    );
    return result.rows.length > 0;
  } catch (error: any) {
    logger.error(
      { error: error.message, dashboardId, viewerType },
      'Failed to track dashboard view'
    );
    return false;
  }
}
