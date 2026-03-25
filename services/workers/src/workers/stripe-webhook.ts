import PgBoss from 'pg-boss';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, type ProcessStripeWebhookJob } from '../queue';
import { sendEmail, buildSubscriptionWelcomeEmail, buildPaymentFailedEmail, buildSubscriptionCancelledEmail } from '../services/email';

// Tier hierarchy: higher number = more access (mirrors api/src/services/stripe.ts)
const SUBSCRIPTION_TIERS: Record<string, number> = {
  free: 0,
  plus: 1,
  pro: 2,
  gold: 3,
};

type SubscriptionTier = 'free' | 'plus' | 'pro' | 'gold';
type SubscriptionStatus = 'free' | 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';

/**
 * Resolve which subscription tier a Stripe Price ID belongs to.
 */
function getTierForPriceId(priceId: string): SubscriptionTier {
  const priceToTier: Record<string, SubscriptionTier> = {};

  if (config.stripe.plusMonthlyPriceId) priceToTier[config.stripe.plusMonthlyPriceId] = 'plus';
  if (config.stripe.plusYearlyPriceId) priceToTier[config.stripe.plusYearlyPriceId] = 'plus';
  if (config.stripe.proMonthlyPriceId) priceToTier[config.stripe.proMonthlyPriceId] = 'pro';
  if (config.stripe.proYearlyPriceId) priceToTier[config.stripe.proYearlyPriceId] = 'pro';
  if (config.stripe.goldMonthlyPriceId) priceToTier[config.stripe.goldMonthlyPriceId] = 'gold';
  if (config.stripe.goldYearlyPriceId) priceToTier[config.stripe.goldYearlyPriceId] = 'gold';

  return priceToTier[priceId] || 'free';
}

/**
 * Map Stripe subscription status to our internal status.
 */
function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active': return 'active';
    case 'trialing': return 'trialing';
    case 'past_due': return 'past_due';
    case 'canceled':
    case 'cancelled': return 'cancelled';
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired': return 'expired';
    default: return 'expired';
  }
}

const FRONTEND_URL = config.frontend.url;

/**
 * Stripe Webhook Worker
 *
 * Processes Stripe webhook events asynchronously via pg-boss.
 * Events are published by the API webhook endpoint after signature verification.
 */
export async function registerStripeWebhookWorker(boss: PgBoss): Promise<void> {
  await boss.work<ProcessStripeWebhookJob>(
    QUEUE_NAMES.PROCESS_STRIPE_WEBHOOK,
    {
      teamSize: 3,
      teamConcurrency: 1,
    },
    async (job) => {
      const { eventId, eventType, eventData } = job.data;

      logger.info({ eventId, eventType }, 'Processing Stripe webhook event');

      const pool = getPostgresPool();

      try {
        switch (eventType) {
          case 'checkout.session.completed':
            await handleCheckoutCompleted(pool, eventData);
            break;

          case 'customer.subscription.created':
          case 'customer.subscription.updated':
            await handleSubscriptionUpdated(pool, eventData);
            break;

          case 'customer.subscription.deleted':
            await handleSubscriptionDeleted(pool, eventData);
            break;

          case 'invoice.paid':
            await handleInvoicePaid(pool, eventData);
            break;

          case 'invoice.payment_failed':
            await handlePaymentFailed(pool, eventData, boss);
            break;

          default:
            logger.info({ eventType }, 'Unhandled Stripe event type');
        }

        logger.info({ eventId, eventType }, 'Stripe webhook event processed');
      } catch (error) {
        logger.error({ eventId, eventType, error }, 'Error processing Stripe webhook event');
        throw error; // Rethrow to trigger pg-boss retry
      }
    },
  );

  logger.info('Stripe webhook worker registered');
}

/**
 * Handle checkout.session.completed
 * User finished the Stripe Checkout flow — link subscription to our user.
 */
async function handleCheckoutCompleted(pool: any, eventData: any): Promise<void> {
  const customerId = eventData.customer;
  const subscriptionId = eventData.subscription;

  if (!customerId || !subscriptionId) {
    logger.warn({ eventData }, 'Checkout completed but missing customer or subscription');
    return;
  }

  // Find the user by Stripe customer ID
  const userResult = await pool.query(
    'SELECT id, email, email_verified FROM users WHERE stripe_customer_id = $1',
    [customerId],
  );

  if (userResult.rows.length === 0) {
    logger.warn({ customerId }, 'No user found for Stripe customer');
    return;
  }

  const user = userResult.rows[0];

  // Store the subscription ID (details will be updated via subscription.updated event)
  await pool.query(
    `UPDATE users SET subscription_stripe_id = $1 WHERE id = $2`,
    [subscriptionId, user.id],
  );

  logger.info({ userId: user.id, subscriptionId }, 'Linked Stripe subscription to user');
}

/**
 * Handle customer.subscription.created / customer.subscription.updated
 * Subscription state changed — update tier, status, and period dates.
 */
async function handleSubscriptionUpdated(pool: any, eventData: any): Promise<void> {
  const customerId = eventData.customer;
  const subscriptionId = eventData.id;
  const stripeStatus = eventData.status;
  const cancelAtPeriodEnd = eventData.cancel_at_period_end ?? false;

  // Get the price ID from the subscription items
  const priceId = eventData.items?.data?.[0]?.price?.id;
  const periodStart = eventData.current_period_start
    ? new Date(eventData.current_period_start * 1000)
    : null;
  const periodEnd = eventData.current_period_end
    ? new Date(eventData.current_period_end * 1000)
    : null;

  // Resolve tier and status
  const tier = priceId ? getTierForPriceId(priceId) : 'free';
  const status = mapStripeStatus(stripeStatus);

  // Determine the effective tier: if subscription is not active/trialing, user gets free tier
  const effectiveTier = ['active', 'trialing'].includes(status) ? tier : 'free';

  const result = await pool.query(
    `UPDATE users
     SET subscription_tier = $1,
         subscription_status = $2,
         subscription_stripe_id = $3,
         subscription_price_id = $4,
         subscription_current_period_start = $5,
         subscription_current_period_end = $6,
         subscription_cancel_at_period_end = $7
     WHERE stripe_customer_id = $8
     RETURNING id, email, email_verified`,
    [effectiveTier, status, subscriptionId, priceId, periodStart, periodEnd, cancelAtPeriodEnd, customerId],
  );

  if (result.rows.length === 0) {
    logger.warn({ customerId }, 'No user found for subscription update');
    return;
  }

  const user = result.rows[0];
  logger.info(
    { userId: user.id, tier: effectiveTier, status, cancelAtPeriodEnd },
    'Updated user subscription',
  );

  // Send welcome email on first activation
  if (status === 'active' && user.email && user.email_verified) {
    const { to, template } = buildSubscriptionWelcomeEmail(user.email, effectiveTier, FRONTEND_URL);
    await sendEmail(to, template);
    logger.info({ userId: user.id, tier: effectiveTier }, 'Sent subscription welcome email');
  }
}

/**
 * Handle customer.subscription.deleted
 * Subscription was fully cancelled/terminated — revert to free tier.
 */
async function handleSubscriptionDeleted(pool: any, eventData: any): Promise<void> {
  const customerId = eventData.customer;

  const result = await pool.query(
    `UPDATE users
     SET subscription_tier = 'free',
         subscription_status = 'expired',
         subscription_stripe_id = NULL,
         subscription_price_id = NULL,
         subscription_current_period_start = NULL,
         subscription_current_period_end = NULL,
         subscription_cancel_at_period_end = FALSE
     WHERE stripe_customer_id = $1
     RETURNING id, email, email_verified`,
    [customerId],
  );

  if (result.rows.length === 0) {
    logger.warn({ customerId }, 'No user found for subscription deletion');
    return;
  }

  const user = result.rows[0];
  logger.info({ userId: user.id }, 'Subscription deleted — reverted to free tier');

  // Send cancellation email
  if (user.email && user.email_verified) {
    const { to, template } = buildSubscriptionCancelledEmail(user.email, FRONTEND_URL);
    await sendEmail(to, template);
  }
}

/**
 * Handle invoice.paid
 * Payment succeeded — ensure subscription is active.
 */
async function handleInvoicePaid(pool: any, eventData: any): Promise<void> {
  const customerId = eventData.customer;
  const subscriptionId = eventData.subscription;

  if (!subscriptionId) {
    // One-off invoice, not related to a subscription
    return;
  }

  // Ensure subscription status is active
  await pool.query(
    `UPDATE users
     SET subscription_status = 'active'
     WHERE stripe_customer_id = $1
       AND subscription_stripe_id = $2
       AND subscription_status != 'active'`,
    [customerId, subscriptionId],
  );

  logger.info({ customerId, subscriptionId }, 'Invoice paid — subscription confirmed active');
}

/**
 * Handle invoice.payment_failed
 * Payment failed — mark as past_due and notify user.
 */
async function handlePaymentFailed(pool: any, eventData: any, boss: PgBoss): Promise<void> {
  const customerId = eventData.customer;
  const subscriptionId = eventData.subscription;

  if (!subscriptionId) {
    return;
  }

  const result = await pool.query(
    `UPDATE users
     SET subscription_status = 'past_due'
     WHERE stripe_customer_id = $1
       AND subscription_stripe_id = $2
     RETURNING id, email, email_verified`,
    [customerId, subscriptionId],
  );

  if (result.rows.length === 0) {
    return;
  }

  const user = result.rows[0];
  logger.warn({ userId: user.id, subscriptionId }, 'Subscription payment failed — marked past_due');

  // Send payment failed notification
  if (user.email && user.email_verified) {
    const { to, template } = buildPaymentFailedEmail(user.email, FRONTEND_URL);
    await sendEmail(to, template);
    logger.info({ userId: user.id }, 'Sent payment failed notification email');
  }
}
