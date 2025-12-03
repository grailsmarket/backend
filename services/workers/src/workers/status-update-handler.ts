/**
 * Status Update Handler
 *
 * Handles updating listing/offer status in database based on validation results.
 * Also creates user notifications for status changes.
 */

import { getPostgresPool } from '../../../shared/src';
import { ValidationResult } from './types';

const pool = getPostgresPool();

/**
 * Create notification for user
 * Note: notifications table schema uses user_id (not user_address)
 * For now, we'll store notification data in metadata field
 */
async function createNotification(params: {
  user_address: string;
  type: string;
  title: string;
  message: string;
  data: any;
}): Promise<void> {
  // Get user_id from users table (if exists)
  const userResult = await pool.query(`
    SELECT id FROM users WHERE LOWER(address) = LOWER($1) LIMIT 1
  `, [params.user_address]);

  // Only create notification if user exists in system
  if (userResult.rows.length > 0) {
    const userId = userResult.rows[0].id;

    await pool.query(`
      INSERT INTO notifications (user_id, type, metadata, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [
      userId,
      params.type,
      JSON.stringify({
        title: params.title,
        message: params.message,
        ...params.data
      })
    ]);
  } else {
    console.log(`User ${params.user_address} not found, skipping notification`);
  }
}

/**
 * Update listing status based on validation result
 */
export async function updateListingStatus(
  listingId: number,
  validationResult: ValidationResult,
  action?: 'refunded'
): Promise<void> {
  const { isValid, reason, details } = validationResult;

  try {
    if (!isValid && action !== 'refunded') {
      // Mark as unfunded
      const updateResult = await pool.query(`
        UPDATE listings
        SET status = 'unfunded',
            unfunded_at = NOW(),
            unfunded_reason = $2,
            last_validated_at = NOW()
        WHERE id = $1
          AND status = 'active'
        RETURNING seller_address
      `, [listingId, reason]);

      if (updateResult.rows.length > 0) {
        // Get listing details for notification
        const listing = await pool.query(`
          SELECT l.seller_address, en.name
          FROM listings l
          JOIN ens_names en ON en.id = l.ens_name_id
          WHERE l.id = $1
        `, [listingId]);

        if (listing.rows.length > 0) {
          const { seller_address, name } = listing.rows[0];

          // Create notification
          await createNotification({
            user_address: seller_address,
            type: 'listing_unfunded',
            title: 'Listing Unfunded',
            message: `Your listing for ${name} has been marked as unfunded because you no longer own this name`,
            data: {
              listing_id: listingId,
              name,
              reason,
              details
            }
          });

          console.log(`Listing ${listingId} (${name}) marked as unfunded: ${reason}`);
        }
      }

    } else if (isValid && action === 'refunded') {
      // Was unfunded, now valid again - restore to active
      const updateResult = await pool.query(`
        UPDATE listings
        SET status = 'active',
            unfunded_at = NULL,
            unfunded_reason = NULL,
            last_validated_at = NOW()
        WHERE id = $1
          AND status = 'unfunded'
        RETURNING seller_address
      `, [listingId]);

      if (updateResult.rows.length > 0) {
        // Get listing details for notification
        const listing = await pool.query(`
          SELECT l.seller_address, en.name
          FROM listings l
          JOIN ens_names en ON en.id = l.ens_name_id
          WHERE l.id = $1
        `, [listingId]);

        if (listing.rows.length > 0) {
          const { seller_address, name } = listing.rows[0];

          // Create notification
          await createNotification({
            user_address: seller_address,
            type: 'listing_refunded',
            title: 'Listing Restored',
            message: `Your listing for ${name} is now active again`,
            data: {
              listing_id: listingId,
              name
            }
          });

          console.log(`Listing ${listingId} (${name}) restored to active`);
        }
      }

    } else {
      // Still valid, just update timestamp
      await pool.query(`
        UPDATE listings
        SET last_validated_at = NOW()
        WHERE id = $1
      `, [listingId]);
    }

    // Update validation state tracking
    await pool.query(`
      INSERT INTO validation_state (entity_type, entity_id, last_check_at, next_check_at, check_count)
      VALUES ('listing', $1, NOW(), NOW() + INTERVAL '1 hour', 1)
      ON CONFLICT (entity_type, entity_id)
      DO UPDATE SET
        last_check_at = NOW(),
        next_check_at = NOW() + INTERVAL '1 hour',
        check_count = validation_state.check_count + 1,
        consecutive_failures = CASE WHEN $2 THEN validation_state.consecutive_failures + 1 ELSE 0 END
    `, [listingId, !isValid]);

  } catch (error: any) {
    console.error(`Error updating listing status for ${listingId}:`, error);
    throw error;
  }
}

/**
 * Update offer status based on validation result
 */
export async function updateOfferStatus(
  offerId: number,
  validationResult: ValidationResult,
  action?: 'refunded'
): Promise<void> {
  const { isValid, reason, details } = validationResult;

  try {
    if (!isValid && action !== 'refunded') {
      // Mark as unfunded
      const updateResult = await pool.query(`
        UPDATE offers
        SET status = 'unfunded',
            unfunded_at = NOW(),
            unfunded_reason = $2,
            last_validated_at = NOW()
        WHERE id = $1
          AND status = 'pending'
        RETURNING buyer_address
      `, [offerId, reason]);

      if (updateResult.rows.length > 0) {
        // Get offer details for notification
        const offer = await pool.query(`
          SELECT o.buyer_address, en.name, o.price_wei, o.currency_address
          FROM offers o
          JOIN ens_names en ON en.id = o.ens_name_id
          WHERE o.id = $1
        `, [offerId]);

        if (offer.rows.length > 0) {
          const { buyer_address, name } = offer.rows[0];
          const currency = details?.currency || 'ETH';

          // Create notification
          await createNotification({
            user_address: buyer_address,
            type: 'offer_unfunded',
            title: 'Offer Unfunded',
            message: `Your offer on ${name} is no longer funded (insufficient ${currency} balance)`,
            data: {
              offer_id: offerId,
              name,
              reason,
              details
            }
          });

          console.log(`Offer ${offerId} on ${name} marked as unfunded: ${reason}`);
        }
      }

    } else if (isValid && action === 'refunded') {
      // Was unfunded, now valid again - restore to pending
      const updateResult = await pool.query(`
        UPDATE offers
        SET status = 'pending',
            unfunded_at = NULL,
            unfunded_reason = NULL,
            last_validated_at = NOW()
        WHERE id = $1
          AND status = 'unfunded'
        RETURNING buyer_address
      `, [offerId]);

      if (updateResult.rows.length > 0) {
        // Get offer details for notification
        const offer = await pool.query(`
          SELECT o.buyer_address, en.name
          FROM offers o
          JOIN ens_names en ON en.id = o.ens_name_id
          WHERE o.id = $1
        `, [offerId]);

        if (offer.rows.length > 0) {
          const { buyer_address, name } = offer.rows[0];

          // Create notification
          await createNotification({
            user_address: buyer_address,
            type: 'offer_refunded',
            title: 'Offer Restored',
            message: `Your offer on ${name} is now active again`,
            data: {
              offer_id: offerId,
              name
            }
          });

          console.log(`Offer ${offerId} on ${name} restored to pending`);
        }
      }

    } else {
      // Still valid, just update timestamp
      await pool.query(`
        UPDATE offers
        SET last_validated_at = NOW()
        WHERE id = $1
      `, [offerId]);
    }

    // Update validation state tracking
    await pool.query(`
      INSERT INTO validation_state (entity_type, entity_id, last_check_at, next_check_at, check_count)
      VALUES ('offer', $1, NOW(), NOW() + INTERVAL '5 minutes', 1)
      ON CONFLICT (entity_type, entity_id)
      DO UPDATE SET
        last_check_at = NOW(),
        next_check_at = NOW() + INTERVAL '5 minutes',
        check_count = validation_state.check_count + 1,
        consecutive_failures = CASE WHEN $2 THEN validation_state.consecutive_failures + 1 ELSE 0 END
    `, [offerId, !isValid]);

  } catch (error: any) {
    console.error(`Error updating offer status for ${offerId}:`, error);
    throw error;
  }
}

/**
 * Batch update offer statuses
 */
export async function batchUpdateOfferStatuses(
  results: Map<number, ValidationResult>,
  action?: 'refunded'
): Promise<void> {
  for (const [offerId, result] of results.entries()) {
    try {
      await updateOfferStatus(offerId, result, action);
    } catch (error: any) {
      console.error(`Failed to update offer ${offerId}:`, error.message);
      // Continue with other offers
    }
  }
}
