import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, config, type APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { getQueueClient, QUEUE_NAMES } from '../queue';
import {
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
  getOrCreateStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  getPriceIdForTier,
} from '../services/stripe';

const CheckoutSchema = z.object({
  tier: z.enum(['plus', 'pro', 'gold']),
  interval: z.enum(['monthly', 'yearly']),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

export async function subscriptionsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/subscriptions/status
   * Get current user's subscription tier and billing status
   */
  fastify.get('/status', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const userId = parseInt(request.user!.sub);

      const result = await pool.query(
        `SELECT subscription_tier, subscription_status, subscription_price_id,
                subscription_current_period_start, subscription_current_period_end,
                subscription_cancel_at_period_end
         FROM users WHERE id = $1`,
        [userId],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const user = result.rows[0];

      const response: APIResponse = {
        success: true,
        data: {
          tier: user.subscription_tier,
          status: user.subscription_status,
          priceId: user.subscription_price_id,
          currentPeriodStart: user.subscription_current_period_start,
          currentPeriodEnd: user.subscription_current_period_end,
          cancelAtPeriodEnd: user.subscription_cancel_at_period_end,
        },
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching subscription status:', error);
      return reply.status(500).send({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch subscription status' },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * GET /api/v1/subscriptions/tiers
   * List available subscription tiers (public endpoint for frontend)
   */
  fastify.get('/tiers', async (_request, reply) => {
    const tiers = [
      { tier: 'free', level: SUBSCRIPTION_TIERS.free },
      {
        tier: 'plus',
        level: SUBSCRIPTION_TIERS.plus,
        monthlyPriceId: config.stripe.plusMonthlyPriceId || null,
        yearlyPriceId: config.stripe.plusYearlyPriceId || null,
      },
      {
        tier: 'pro',
        level: SUBSCRIPTION_TIERS.pro,
        monthlyPriceId: config.stripe.proMonthlyPriceId || null,
        yearlyPriceId: config.stripe.proYearlyPriceId || null,
      },
      {
        tier: 'gold',
        level: SUBSCRIPTION_TIERS.gold,
        monthlyPriceId: config.stripe.goldMonthlyPriceId || null,
        yearlyPriceId: config.stripe.goldYearlyPriceId || null,
      },
    ];

    const response: APIResponse = {
      success: true,
      data: { tiers },
      meta: { timestamp: new Date().toISOString() },
    };

    return reply.send(response);
  });

  /**
   * POST /api/v1/subscriptions/checkout
   * Create a Stripe Checkout Session and return the URL
   */
  fastify.post('/checkout', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { tier, interval, successUrl, cancelUrl } = CheckoutSchema.parse(request.body);
      const userId = parseInt(request.user!.sub);
      const address = request.user!.address;

      // Resolve the Stripe Price ID for the requested tier + interval
      const priceId = getPriceIdForTier(tier as SubscriptionTier, interval);
      if (!priceId) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_TIER',
            message: `Price not configured for ${tier} ${interval}`,
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // Get user email for Stripe customer
      const userResult = await pool.query(
        'SELECT email FROM users WHERE id = $1',
        [userId],
      );
      const email = userResult.rows[0]?.email;

      // Get or create Stripe customer
      const stripeCustomerId = await getOrCreateStripeCustomer(userId, address, email);

      // Create Checkout Session
      const defaultSuccessUrl = `${config.frontend.url}/subscription/success?session_id={CHECKOUT_SESSION_ID}`;
      const defaultCancelUrl = `${config.frontend.url}/subscription/cancel`;

      const session = await createCheckoutSession(
        stripeCustomerId,
        priceId,
        successUrl || defaultSuccessUrl,
        cancelUrl || defaultCancelUrl,
      );

      const response: APIResponse = {
        success: true,
        data: { url: session.url },
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error creating checkout session:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      return reply.status(500).send({
        success: false,
        error: { code: 'CHECKOUT_FAILED', message: 'Failed to create checkout session' },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/subscriptions/portal
   * Create a Stripe Customer Portal session for self-service management
   */
  fastify.post('/portal', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const userId = parseInt(request.user!.sub);

      // Look up user's Stripe customer ID
      const result = await pool.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1',
        [userId],
      );

      const stripeCustomerId = result.rows[0]?.stripe_customer_id;
      if (!stripeCustomerId) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'NO_SUBSCRIPTION',
            message: 'No active subscription found. Please subscribe first.',
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const returnUrl = `${config.frontend.url}/settings/subscription`;
      const session = await createPortalSession(stripeCustomerId, returnUrl);

      const response: APIResponse = {
        success: true,
        data: { url: session.url },
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error creating portal session:', error);
      return reply.status(500).send({
        success: false,
        error: { code: 'PORTAL_FAILED', message: 'Failed to create billing portal session' },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/subscriptions/webhook
   * Stripe webhook receiver — unauthenticated, verified via signature
   */
  fastify.post('/webhook', async (request, reply) => {
    try {
      const signature = request.headers['stripe-signature'] as string;
      if (!signature) {
        return reply.status(400).send({ error: 'Missing stripe-signature header' });
      }

      // rawBody is attached by the custom content type parser in index.ts
      const rawBody = (request as any).rawBody as Buffer;
      if (!rawBody) {
        return reply.status(400).send({ error: 'Missing raw body for signature verification' });
      }

      // Verify webhook signature
      const event = constructWebhookEvent(rawBody, signature);

      // Deduplicate: check if we've already processed this event
      const existing = await pool.query(
        'SELECT id FROM billing_events WHERE stripe_event_id = $1',
        [event.id],
      );

      if (existing.rows.length > 0) {
        // Already processed — return 200 so Stripe doesn't retry
        return reply.status(200).send({ received: true, duplicate: true });
      }

      // Determine the user_id from the event (if we can)
      let userId: number | null = null;
      const eventObj = event.data.object as any;

      if (eventObj.customer) {
        const customerResult = await pool.query(
          'SELECT id FROM users WHERE stripe_customer_id = $1',
          [eventObj.customer],
        );
        userId = customerResult.rows[0]?.id ?? null;
      }

      // Log the event in billing_events
      await pool.query(
        `INSERT INTO billing_events (user_id, stripe_event_id, event_type, event_data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (stripe_event_id) DO NOTHING`,
        [userId, event.id, event.type, JSON.stringify(event.data.object)],
      );

      // Publish to pg-boss for async processing
      const boss = await getQueueClient();
      await boss.send(QUEUE_NAMES.PROCESS_STRIPE_WEBHOOK, {
        eventId: event.id,
        eventType: event.type,
        eventData: event.data.object,
      });

      // Return 200 immediately — Stripe requires a fast response
      return reply.status(200).send({ received: true });
    } catch (error: any) {
      fastify.log.error('Webhook error:', error);

      // Stripe signature verification failure
      if (error.type === 'StripeSignatureVerificationError') {
        return reply.status(400).send({ error: 'Invalid signature' });
      }

      return reply.status(500).send({ error: 'Webhook processing failed' });
    }
  });
}
