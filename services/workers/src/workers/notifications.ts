import PgBoss from 'pg-boss';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, type SendNotificationJob } from '../queue';
import {
  sendEmail,
  buildNewListingEmail,
  buildPriceChangeEmail,
  buildSaleEmail,
  buildNewOfferEmail,
  buildListingCancelledEmail,
  buildOfferReceivedEmail,
  buildListingSoldEmail,
  buildSupportTicketUpdateEmail,
} from '../services/email';
import {
  sendTelegramMessage,
  buildTelegramNotification,
  buildSupportTicketUpdateTelegram,
} from '../services/telegram';
import { ethers } from 'ethers';

const FRONTEND_URL = config.frontend.url;

/**
 * Notification Worker
 *
 * Handles sending email and Telegram notifications to users based on watchlist events
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

      // Support tickets follow a separate path: no ENS name lookup, no
      // dedupe window, and the in-app notification row is always written
      // even when no email/Telegram channel is available.
      if (type === 'support-ticket-update') {
        await processSupportTicketNotification({ userId, metadata });
        return;
      }

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

        // Get recipient details (email + telegram)
        let recipientEmail = email;
        let telegramChatId: number | null = null;
        let telegramConnected = false;
        let isPro = false;

        if (userId) {
          const userResult = await pool.query(
            `SELECT email, email_verified, telegram_connected, telegram_chat_id,
                    tier, tier_expires_at
             FROM users WHERE id = $1`,
            [userId]
          );

          if (userResult.rows.length === 0) {
            logger.warn({ userId }, 'User not found for notification');
            return;
          }

          const user = userResult.rows[0];

          // Email path
          if (!recipientEmail && user.email_verified) {
            recipientEmail = user.email;
          }
          if (recipientEmail && !user.email_verified) {
            recipientEmail = undefined;
          }

          // Telegram path
          telegramConnected = user.telegram_connected;
          telegramChatId = user.telegram_chat_id ? Number(user.telegram_chat_id) : null;

          // Pro tier check for Telegram
          isPro = user.tier && user.tier !== 'free' &&
            (!user.tier_expires_at || new Date(user.tier_expires_at) > new Date());
        }

        // If no email and no telegram, nothing to do
        if (!recipientEmail && !(telegramConnected && telegramChatId && isPro)) {
          if (recipientAddress) {
            logger.info({ recipientAddress }, 'No email or telegram for recipient, skipping notification');
          } else {
            logger.warn({ type, userId, ensNameId }, 'No notification channel available for recipient');
          }
          return;
        }

        // Check if we already sent this notification (deduplication)
        if (userId) {
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

        // --- Send email notification ---
        if (recipientEmail) {
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
              break;
          }

          if (emailTemplate) {
            await sendEmail(recipientEmail, emailTemplate);
            logger.info({ userId, type, ensNameId, email: recipientEmail }, 'Email notification sent');
          }
        }

        // --- Send Telegram notification ---
        if (telegramConnected && telegramChatId && isPro) {
          try {
            const telegramText = buildTelegramNotification(
              type,
              ensName,
              metadata,
              ethers.formatEther,
            );

            if (telegramText) {
              await sendTelegramMessage({
                chatId: telegramChatId,
                text: telegramText,
              });
              logger.info({ userId, type, ensNameId, chatId: telegramChatId }, 'Telegram notification sent');
            }
          } catch (telegramError: any) {
            const errorMsg = telegramError?.message || String(telegramError);

            // If the bot was blocked or chat not found, disconnect the user
            if (
              errorMsg.includes('bot was blocked') ||
              errorMsg.includes('chat not found') ||
              errorMsg.includes('user is deactivated') ||
              errorMsg.includes('PEER_ID_INVALID')
            ) {
              logger.warn({ userId, telegramChatId }, 'Telegram bot blocked or chat not found, disconnecting');
              await pool.query(
                `UPDATE users SET telegram_connected = FALSE, telegram_chat_id = NULL WHERE id = $1`,
                [userId]
              );
            } else {
              logger.error({ error: telegramError, userId, telegramChatId }, 'Failed to send Telegram notification');
            }
            // Don't throw -- email may have already been sent
          }
        }

        // Log notification in database
        if (userId) {
          await pool.query(
            `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [userId, type, ensNameId, JSON.stringify(metadata || {})]
          );

          logger.info({ userId, type, ensNameId }, 'Notification logged');
        }
      } catch (error) {
        logger.error({ error, type, userId, ensNameId }, 'Error sending notification');
        throw error; // Will trigger pg-boss retry
      }
    }
  );

  logger.info('Notification worker registered');
}

/**
 * Handle a support ticket notification: write the in-app row, then best-effort
 * email and Telegram. Recipients can be the ticket owner (admin reply, status
 * change) or an admin (user reopen).
 */
async function processSupportTicketNotification(params: {
  userId?: number;
  metadata?: Record<string, any>;
}): Promise<void> {
  const { userId, metadata } = params;
  if (!userId) {
    logger.warn({ metadata }, 'support-ticket-update missing userId');
    return;
  }

  const kind = metadata?.kind as 'admin_reply' | 'status_changed' | 'reopened' | undefined;
  const ticketId = metadata?.ticketId;
  const subject = metadata?.subject ?? 'your support ticket';
  const newStatus = metadata?.newStatus ?? metadata?.status;
  if (!kind || !ticketId) {
    logger.warn({ userId, metadata }, 'support-ticket-update missing kind/ticketId');
    return;
  }

  const pool = getPostgresPool();

  // 1. Always write the in-app notification row.
  await pool.query(
    `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
     VALUES ($1, 'support-ticket-update', NULL, $2, NOW())`,
    [userId, JSON.stringify(metadata || {})]
  );

  // 2. Look up delivery channels.
  const userRes = await pool.query(
    `SELECT email, email_verified, telegram_connected, telegram_chat_id,
            tier, tier_expires_at
       FROM users WHERE id = $1`,
    [userId]
  );
  if (userRes.rows.length === 0) {
    logger.warn({ userId }, 'User not found for support ticket notification');
    return;
  }
  const user = userRes.rows[0];

  const ticketUrl = `${FRONTEND_URL}/support?ticket=${ticketId}`;
  const unsubscribeUrl = `${FRONTEND_URL}/settings/notifications`;

  // 3. Email (if verified address on file).
  if (user.email && user.email_verified) {
    try {
      const template = buildSupportTicketUpdateEmail({
        kind,
        subject,
        ticketUrl,
        newStatus,
        unsubscribeUrl,
      });
      await sendEmail(user.email, template);
      logger.info({ userId, kind, ticketId }, 'Support ticket email sent');
    } catch (err) {
      logger.error({ err, userId, ticketId }, 'Failed to send support ticket email');
    }
  }

  // 4. Telegram (paid users with a connected chat).
  const tier = user.tier;
  const tierActive =
    tier && tier !== 'free' &&
    (!user.tier_expires_at || new Date(user.tier_expires_at) > new Date());
  if (user.telegram_connected && user.telegram_chat_id && tierActive) {
    try {
      const text = buildSupportTicketUpdateTelegram({
        kind,
        subject,
        ticketUrl,
        newStatus,
      });
      await sendTelegramMessage({
        chatId: Number(user.telegram_chat_id),
        text,
      });
      logger.info({ userId, kind, ticketId }, 'Support ticket Telegram sent');
    } catch (err) {
      logger.error({ err, userId, ticketId }, 'Failed to send support ticket Telegram');
    }
  }
}
