import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const pool = getPostgresPool();

/**
 * Track a profile view by any user (authenticated or anonymous).
 * Fire-and-forget — never throws.
 */
export async function trackProfileView(
  profileAddress: string,
  viewerIdentifier: string,
  viewerType: 'authenticated' | 'anonymous' = 'anonymous'
): Promise<boolean> {
  try {
    const result = await pool.query(
      `INSERT INTO profile_views (profile_address, viewer_identifier, viewer_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (profile_address, viewer_identifier) DO NOTHING
       RETURNING id`,
      [profileAddress.toLowerCase(), viewerIdentifier, viewerType]
    );

    const isNewView = result.rows.length > 0;

    if (isNewView) {
      logger.debug({ profileAddress, viewerType }, 'Tracked new profile view');
    }

    return isNewView;
  } catch (error: any) {
    logger.error(
      { error: error.message, profileAddress, viewerType },
      'Failed to track profile view'
    );
    return false;
  }
}

/**
 * Get unique view count for a profile address.
 */
export async function getProfileViewCount(profileAddress: string): Promise<number> {
  try {
    const result = await pool.query(
      'SELECT COUNT(*)::int AS count FROM profile_views WHERE profile_address = $1',
      [profileAddress.toLowerCase()]
    );

    return result.rows[0]?.count || 0;
  } catch (error: any) {
    logger.error(
      { error: error.message, profileAddress },
      'Failed to get profile view count'
    );
    return 0;
  }
}
