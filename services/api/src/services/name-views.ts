import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import type { FastifyRequest } from 'fastify';

const pool = getPostgresPool();

// Salt for IP hashing - should be set via environment variable in production
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'grails-view-tracking-salt-2025';

/**
 * Hash an IP address for privacy-friendly storage
 * Uses SHA-256 with salt to create irreversible hash
 *
 * @param ip - The IP address to hash
 * @returns A 16-character hash of the IP address
 */
function hashIP(ip: string): string {
  return crypto
    .createHash('sha256')
    .update(ip + IP_HASH_SALT)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Get viewer identifier from request
 * - For authenticated users: returns "user:{userId}"
 * - For anonymous users: returns "ip:{hashedIP}"
 *
 * @param request - Fastify request object
 * @returns A unique identifier for the viewer
 */
export function getViewerIdentifier(request: FastifyRequest): {
  identifier: string;
  type: 'authenticated' | 'anonymous';
} {
  // Check for authenticated user first
  if ((request as any).user?.sub) {
    return {
      identifier: `user:${(request as any).user.sub}`,
      type: 'authenticated',
    };
  }

  // For anonymous: use hashed IP address
  // Fastify with trust proxy will set x-forwarded-for
  const forwarded = request.headers['x-forwarded-for'];
  const ip = forwarded
    ? (Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim())
    : request.ip;

  const hashedIP = hashIP(ip);

  return {
    identifier: `ip:${hashedIP}`,
    type: 'anonymous',
  };
}

/**
 * Track a view of an ENS name by an authenticated user (LEGACY)
 * This function is preserved for backward compatibility
 * New code should use the updated trackNameView function
 *
 * @deprecated Use trackNameView with getViewerIdentifier instead
 * @param ensNameId - The ID of the ENS name being viewed
 * @param userId - The ID of the authenticated user viewing the name
 * @returns Promise that resolves to true if view was counted, false if duplicate
 */
export async function trackAuthenticatedNameView(
  ensNameId: number,
  userId: number
): Promise<boolean> {
  try {
    // Try to insert a new view record
    // ON CONFLICT DO NOTHING ensures we only count each user once per name
    const result = await pool.query(
      `INSERT INTO name_views (ens_name_id, viewer_identifier, viewer_type)
       VALUES ($1, $2, 'authenticated')
       ON CONFLICT (ens_name_id, viewer_identifier) DO NOTHING
       RETURNING id`,
      [ensNameId, `user:${userId}`]
    );

    // If a row was inserted, it's a new unique view
    const isNewView = result.rows.length > 0;

    if (isNewView) {
      logger.debug(
        { ensNameId, userId },
        'Tracked new authenticated name view'
      );
    } else {
      logger.debug(
        { ensNameId, userId },
        'Duplicate authenticated view - not counted'
      );
    }

    return isNewView;

    // Note: The view_count increment happens automatically via database trigger
    // See migration file: after_name_view_insert trigger
  } catch (error: any) {
    // Log the error but don't throw - view tracking should never break the main request
    logger.error(
      { error: error.message, ensNameId, userId },
      'Failed to track authenticated name view'
    );
    return false;
  }
}

/**
 * Track a view of an ENS name by any user (authenticated or anonymous)
 * This function is designed to be called asynchronously (fire-and-forget)
 *
 * @param ensNameId - The ID of the ENS name being viewed
 * @param viewerIdentifier - Unique identifier for the viewer (user ID or hashed IP)
 * @param viewerType - Type of viewer ('authenticated' or 'anonymous')
 * @returns Promise that resolves to true if view was counted, false if duplicate
 */
export async function trackNameView(
  ensNameId: number,
  viewerIdentifier: string,
  viewerType: 'authenticated' | 'anonymous' = 'anonymous'
): Promise<boolean> {
  try {
    // Try to insert a new view record
    // ON CONFLICT DO NOTHING ensures we only count each identifier once per name
    const result = await pool.query(
      `INSERT INTO name_views (ens_name_id, viewer_identifier, viewer_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (ens_name_id, viewer_identifier) DO NOTHING
       RETURNING id`,
      [ensNameId, viewerIdentifier, viewerType]
    );

    // If a row was inserted, it's a new unique view
    const isNewView = result.rows.length > 0;

    if (isNewView) {
      logger.debug(
        { ensNameId, viewerType },
        'Tracked new name view'
      );
    } else {
      logger.debug(
        { ensNameId, viewerType },
        'Duplicate view - not counted'
      );
    }

    return isNewView;

    // Note: The view_count increment happens automatically via database trigger
    // See migration file: after_name_view_insert trigger
  } catch (error: any) {
    // Log the error but don't throw - view tracking should never break the main request
    logger.error(
      { error: error.message, ensNameId, viewerType },
      'Failed to track name view'
    );
    return false;
  }
}

/**
 * Get view count for a specific ENS name
 *
 * @param ensNameId - The ID of the ENS name
 * @returns The number of unique authenticated users who have viewed this name
 */
export async function getNameViewCount(ensNameId: number): Promise<number> {
  try {
    const result = await pool.query(
      'SELECT view_count FROM ens_names WHERE id = $1',
      [ensNameId]
    );

    return result.rows[0]?.view_count || 0;
  } catch (error: any) {
    logger.error(
      { error: error.message, ensNameId },
      'Failed to get name view count'
    );
    return 0;
  }
}

/**
 * Check if a user has viewed a specific name
 *
 * @param ensNameId - The ID of the ENS name
 * @param userId - The ID of the user
 * @returns true if the user has viewed this name before
 */
export async function hasUserViewedName(
  ensNameId: number,
  userId: number
): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM name_views
       WHERE ens_name_id = $1 AND viewer_identifier = $2`,
      [ensNameId, userId.toString()]
    );

    return result.rows.length > 0;
  } catch (error: any) {
    logger.error(
      { error: error.message, ensNameId, userId },
      'Failed to check if user viewed name'
    );
    return false;
  }
}

/**
 * Get most viewed names
 *
 * @param limit - Maximum number of names to return
 * @returns Array of ENS names sorted by view count
 */
export async function getMostViewedNames(limit: number = 10) {
  try {
    const result = await pool.query(
      `SELECT id, name, token_id, view_count
       FROM ens_names
       WHERE view_count > 0
       ORDER BY view_count DESC, name ASC
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  } catch (error: any) {
    logger.error(
      { error: error.message, limit },
      'Failed to get most viewed names'
    );
    return [];
  }
}
