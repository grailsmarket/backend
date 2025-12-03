import PgBoss from 'pg-boss';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, SendNotificationJob } from '../queue';
import {
  sendEmail,
  buildNewListingEmail,
  buildPriceChangeEmail,
  buildSaleEmail,
  buildNewOfferEmail,
  buildListingCancelledEmail,
  buildOfferReceivedEmail,
  buildListingSoldEmail,
} from '../services/email';
import { ethers } from 'ethers';

const FRONTEND_URL = config.frontend.url;

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
      const { type, userId, email, recipientAddress, ensNameId, metadata, transactionHash } = job.data;

      logger.info({ type, userId, ensNameId }, 'Processing notification');

      const pool = getPostgresPool();

      try {
        // Get ENS name details
        const ensResult = await pool.query(
          'SELECT name FROM ens_names WHERE id = $1',
          [ensNameId]
        );

        if (ensResult.rows.length === 0) {
          logger.warn({ ensNameId }, 'ENS name not found for notification');
          return;
        }

        const ensName = ensResult.rows[0].name;

        // Get recipient email if not provided
        let recipientEmail = email;
        if (!recipientEmail && userId) {
          const userResult = await pool.query(
            'SELECT email, email_verified FROM users WHERE id = $1',
            [userId]
          );

          if (userResult.rows.length === 0) {
            logger.warn({ userId }, 'User not found for notification');
            return;
          }

          const user = userResult.rows[0];

          // Check if email is verified
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
          logger.warn({ type, userId, ensNameId }, 'No email found for notification recipient');
          return;
        }

        // Check if we already sent this notification (deduplication)
        // Note: Some notification types should allow duplicates
        if (userId) {
          // Types that should allow multiple notifications within 12 hours
          const allowDuplicates = ['listing-sold'];

          if (!allowDuplicates.includes(type)) {
            const existingNotification = await pool.query(
              `SELECT id, metadata FROM notifications
               WHERE user_id = $1
                 AND type = $2
                 AND ens_name_id = $3
                 AND sent_at > NOW() - INTERVAL '12 hours'`,
              [userId, type, ensNameId]
            );

            if (existingNotification.rows.length > 0) {
              // If this is a new-listing notification and the price is different, allow it
              if (type === 'new-listing' && metadata?.priceWei) {
                const lastNotificationPrice = existingNotification.rows[0].metadata?.priceWei;
                if (lastNotificationPrice && lastNotificationPrice !== metadata.priceWei) {
                  logger.info(
                    { userId, type, ensNameId, oldPrice: lastNotificationPrice, newPrice: metadata.priceWei },
                    'Price changed since last notification, allowing duplicate'
                  );
                } else {
                  logger.info(
                    { userId, type, ensNameId },
                    'Duplicate notification detected (sent within last 12 hours), skipping'
                  );
                  return;
                }
              } else {
                logger.info(
                  { userId, type, ensNameId },
                  'Duplicate notification detected (sent within last 12 hours), skipping'
                );
                return;
              }
            }
          }
        }

        // Build email based on notification type
        let emailTemplate;
        const unsubscribeUrl = `${FRONTEND_URL}/settings/notifications`;

        switch (type) {
          case 'new-listing': {
            const priceWei = metadata?.priceWei || '0';
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
            const oldPriceWei = metadata?.oldPriceWei || '0';
            const newPriceWei = metadata?.newPriceWei || '0';
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
            const priceWei = metadata?.priceWei || '0';
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
            const offerAmountWei = metadata?.offerAmountWei || '0';
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

          case 'offer-received': {
            const offerAmountWei = metadata?.offerAmountWei || '0';
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
            const priceWei = metadata?.priceWei || '0';
            const priceEth = ethers.formatEther(priceWei);

            emailTemplate = buildListingSoldEmail({
              ensName,
              priceEth,
              saleUrl: `${FRONTEND_URL}/${ensName}`,
              unsubscribeUrl,
            });
            break;
          }

          default:
            logger.warn({ type }, 'Unknown notification type');
            return;
        }

        // Send email
        await sendEmail(recipientEmail, emailTemplate);

        // Log notification in database
        if (userId) {
          await pool.query(
            `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [userId, type, ensNameId, JSON.stringify(metadata || {})]
          );

          logger.info({ userId, type, ensNameId, email: recipientEmail }, 'Notification sent and logged');
        } else {
          logger.info({ type, ensNameId, email: recipientEmail }, 'Notification sent (no user record)');
        }
      } catch (error) {
        logger.error({ error, type, userId, ensNameId }, 'Error sending notification');
        throw error; // Will trigger pg-boss retry
      }
    }
  );

  logger.info('Notification worker registered');
}
