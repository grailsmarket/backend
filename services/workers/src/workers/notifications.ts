import PgBoss from 'pg-boss';
import { ethers } from 'ethers';
import { logger } from '../utils/logger';
import { getPostgresPool, config } from '../../../shared/src';
import { QUEUE_NAMES, type SendNotificationJob } from '../queue';
import { sendPushNotifications } from '../utils/push-notification';
import {
  sendEmail,
  buildNewListingEmail,
  buildPriceChangeEmail,
  buildSaleEmail,
  buildNewOfferEmail,
  buildListingCancelledEmail,
  buildOfferReceivedEmail,
  buildListingSoldEmail,
  buildCommentReceivedEmail,
  type EmailTemplate,
} from '../services/email';

const FRONTEND_URL = config.frontend.url;

interface EnsNameRow {
  name: string;
}

interface UserNotificationRow {
  email: string | null;
  email_verified: boolean;
}

interface ExistingNotificationRow {
  id: number;
  metadata: Record<string, unknown> | null;
}

interface InsertedNotificationRow {
  id: number;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }

  return '0';
}

/**
 * Notification Worker
 *
 * Handles sending email notifications to users based on watchlist events
 */

export async function registerNotificationWorker(boss: PgBoss): Promise<void> {
  await boss.work<SendNotificationJob>(
    QUEUE_NAMES.SEND_NOTIFICATION,
    {
      teamSize: 5,
      teamConcurrency: 2,
    },
    async (job) => {
      const { type, userId, email, recipientAddress, ensNameId, metadata } = job.data;

      logger.info({ type, userId, ensNameId }, 'Processing notification');

      const pool = getPostgresPool();

      try {
        // Get ENS name details
        const ensResult = await pool.query<EnsNameRow>('SELECT name FROM ens_names WHERE id = $1', [ensNameId]);

        if (ensResult.rows.length === 0) {
          logger.warn({ ensNameId }, 'ENS name not found for notification');
          return;
        }

        const ensName = ensResult.rows[0].name;

        // Get recipient email if not provided
        let recipientEmail: string | null | undefined = email;
        if (!recipientEmail && userId) {
          const userResult = await pool.query<UserNotificationRow>(
            'SELECT email, email_verified FROM users WHERE id = $1',
            [userId],
          );

          if (userResult.rows.length === 0) {
            logger.warn({ userId }, 'User not found for notification');
            return;
          }

          const user = userResult.rows[0];

          if (!user.email_verified) {
            logger.info({ userId }, 'User email not verified, skipping notification');
            return;
          }

          recipientEmail = user.email;
        }

        if (!recipientEmail && recipientAddress) {
          // For ownership change notifications to seller, we might not have email
          // This is OK - we can add webhook support later
          logger.info({ recipientAddress }, 'No email for recipient, skipping email notification');
          return;
        }

        if (!recipientEmail) {
          logger.info({ type, userId, ensNameId }, 'No verified email found for notification recipient');
        }

        // Check if we already sent this notification (deduplication)
        // Note: Some notification types should allow duplicates
        if (userId) {
          // Types that should allow multiple notifications within 12 hours.
          // Comments are explicitly opt-in via user prefs, and users who turn
          // them on want one ping per comment, not one per 12 hours.
          const allowDuplicates = ['listing-sold', 'comment-received'];

          if (!allowDuplicates.includes(type)) {
            const existingNotification = await pool.query<ExistingNotificationRow>(
              `SELECT id, metadata FROM notifications
               WHERE user_id = $1
                 AND type = $2
                 AND ens_name_id = $3
                 AND sent_at > NOW() - INTERVAL '12 hours'`,
              [userId, type, ensNameId],
            );

            if (existingNotification.rows.length > 0) {
              // If this is a new-listing notification and the price is different, allow it
              if (type === 'new-listing' && metadata?.priceWei) {
                const lastNotificationPrice = existingNotification.rows[0].metadata?.priceWei;
                if (lastNotificationPrice && lastNotificationPrice !== metadata.priceWei) {
                  logger.info(
                    {
                      userId,
                      type,
                      ensNameId,
                      oldPrice: lastNotificationPrice,
                      newPrice: metadata.priceWei,
                    },
                    'Price changed since last notification, allowing duplicate',
                  );
                } else {
                  logger.info(
                    { userId, type, ensNameId },
                    'Duplicate notification detected (sent within last 12 hours), skipping',
                  );
                  return;
                }
              } else {
                logger.info(
                  { userId, type, ensNameId },
                  'Duplicate notification detected (sent within last 12 hours), skipping',
                );
                return;
              }
            }
          }
        }

        // Build email based on notification type
        let emailTemplate: EmailTemplate | undefined;
        const unsubscribeUrl = `${FRONTEND_URL}/settings/notifications`;

        switch (type) {
          case 'new-listing': {
            const priceWei = metadataString(metadata, 'priceWei');
            const priceEth = ethers.formatEther(priceWei);

            emailTemplate = buildNewListingEmail({
              ensName,
              priceEth,
              listingUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          case 'price-change': {
            const oldPriceWei = metadataString(metadata, 'oldPriceWei');
            const newPriceWei = metadataString(metadata, 'newPriceWei');
            const oldPriceEth = ethers.formatEther(oldPriceWei);
            const newPriceEth = ethers.formatEther(newPriceWei);

            emailTemplate = buildPriceChangeEmail({
              ensName,
              oldPriceEth,
              newPriceEth,
              listingUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          case 'sale': {
            const priceWei = metadataString(metadata, 'priceWei');
            const priceEth = ethers.formatEther(priceWei);

            emailTemplate = buildSaleEmail({
              ensName,
              priceEth,
              listingUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          case 'new-offer': {
            const offerAmountWei = metadataString(metadata, 'offerAmountWei');
            const priceEth = ethers.formatEther(offerAmountWei);

            emailTemplate = buildNewOfferEmail({
              ensName,
              priceEth,
              offerUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          case 'listing-cancelled-ownership-change': {
            emailTemplate = buildListingCancelledEmail({
              ensName,
              listingUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          case 'listing-cancelled': {
            emailTemplate = buildListingCancelledEmail({
              ensName,
              listingUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          case 'offer-received': {
            const offerAmountWei = metadataString(metadata, 'offerAmountWei');
            const priceEth = ethers.formatEther(offerAmountWei);

            emailTemplate = buildOfferReceivedEmail({
              ensName,
              priceEth,
              offerUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          case 'listing-sold': {
            const priceWei = metadataString(metadata, 'priceWei');
            const priceEth = ethers.formatEther(priceWei);

            emailTemplate = buildListingSoldEmail({
              ensName,
              priceEth,
              saleUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          case 'comment-received': {
            emailTemplate = buildCommentReceivedEmail({
              ensName,
              nameUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          default:
            logger.warn({ type }, 'Unknown notification type');
            return;
        }

        // Log notification in database as the canonical in-app notification
        let notificationId: number | undefined;
        if (userId) {
          const insertedNotification = await pool.query<InsertedNotificationRow>(
            `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING id`,
            [userId, type, ensNameId, JSON.stringify(metadata || {})],
          );
          notificationId = insertedNotification.rows[0].id;
        }

        if (recipientEmail && emailTemplate) {
          try {
            await sendEmail(recipientEmail, emailTemplate);
          } catch (emailError) {
            logger.warn(
              {
                error: emailError,
                userId,
                type,
                ensNameId,
                email: recipientEmail,
              },
              'Email notification delivery failed after canonical notification was logged',
            );
          }
        }

        if (userId && notificationId !== undefined) {
          try {
            await sendPushNotifications({
              userId,
              type,
              ensName,
              notificationId,
              metadata,
            });
          } catch (pushError) {
            logger.warn(
              { error: pushError, userId, type, ensNameId },
              'Push notification delivery failed after canonical notification was logged',
            );
          }

          logger.info({ userId, type, ensNameId, email: recipientEmail }, 'Notification sent and logged');
        } else {
          logger.info({ type, ensNameId, email: recipientEmail }, 'Notification sent (no user record)');
        }
      } catch (error) {
        logger.error({ error, type, userId, ensNameId }, 'Error sending notification');
        throw error; // Will trigger pg-boss retry
      }
    },
  );

  logger.info('Notification worker registered');
}
