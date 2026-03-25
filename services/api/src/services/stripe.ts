import Stripe from 'stripe';
import { config } from '../../../shared/src';
import { getPostgresPool } from '../../../shared/src';

// Tier hierarchy: higher number = more access
export const SUBSCRIPTION_TIERS = {
  free: 0,
  plus: 1,
  pro: 2,
  gold: 3,
} as const;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIERS;

// Stripe subscription status values we track
export type SubscriptionStatus = 'free' | 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';

// Initialize Stripe client (singleton)
let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!stripeClient) {
    if (!config.stripe.secretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    stripeClient = new Stripe(config.stripe.secretKey);
  }
  return stripeClient;
}

/**
 * Resolve which subscription tier a Stripe Price ID belongs to.
 * Returns 'free' if the price ID is not recognized.
 */
export function getTierForPriceId(priceId: string): SubscriptionTier {
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
 * Get the Stripe Price ID for a given tier and billing interval.
 */
export function getPriceIdForTier(tier: SubscriptionTier, interval: 'monthly' | 'yearly'): string | undefined {
  const priceMap: Record<string, string | undefined> = {
    'plus:monthly': config.stripe.plusMonthlyPriceId,
    'plus:yearly': config.stripe.plusYearlyPriceId,
    'pro:monthly': config.stripe.proMonthlyPriceId,
    'pro:yearly': config.stripe.proYearlyPriceId,
    'gold:monthly': config.stripe.goldMonthlyPriceId,
    'gold:yearly': config.stripe.goldYearlyPriceId,
  };
  return priceMap[`${tier}:${interval}`];
}

/**
 * Find or create a Stripe Customer for a user.
 * Stores the stripe_customer_id on the users table for future lookups.
 */
export async function getOrCreateStripeCustomer(
  userId: number,
  address: string,
  email?: string | null,
): Promise<string> {
  const pool = getPostgresPool();

  // Check if user already has a Stripe customer ID
  const existing = await pool.query(
    'SELECT stripe_customer_id FROM users WHERE id = $1',
    [userId],
  );

  if (existing.rows[0]?.stripe_customer_id) {
    return existing.rows[0].stripe_customer_id;
  }

  // Create a new Stripe customer
  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: {
      grails_user_id: String(userId),
      wallet_address: address,
    },
  });

  // Store the Stripe customer ID on the user
  await pool.query(
    'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
    [customer.id, userId],
  );

  return customer.id;
}

/**
 * Create a Stripe Checkout Session for a subscription.
 */
export async function createCheckoutSession(
  stripeCustomerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient();

  return stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Allow promotion codes for discounts
    allow_promotion_codes: true,
  });
}

/**
 * Create a Stripe Customer Portal session for self-service management.
 */
export async function createPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripeClient();

  return stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
}

/**
 * Verify and construct a Stripe webhook event from raw body and signature.
 */
export function constructWebhookEvent(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  const stripe = getStripeClient();

  if (!config.stripe.webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }

  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    config.stripe.webhookSecret,
  );
}

/**
 * Map a Stripe subscription status string to our internal status.
 */
export function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return 'expired';
    default:
      return 'expired';
  }
}
