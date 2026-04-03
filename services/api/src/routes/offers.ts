import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPostgresPool,
  type APIResponse,
  type Offer,
  validateFeeInOrder,
  getOfferLimits,
  validateBulkOfferLimits,
  invalidateOfferLimitsCache,
} from '../../../shared/src';
import { requireAuth, requireMinTier, requireAdmin } from '../middleware/auth';

const CreateOfferSchema = z.object({
  ensNameId: z.number(),
  buyerAddress: z.string(),
  offerAmountWei: z.string(),
  currencyAddress: z.string().optional(),
  orderData: z.any(),
  expiresAt: z.string().optional(),
});

const UpdateOfferSchema = z.object({
  offerAmountWei: z.string().optional(),
  status: z.enum(['pending', 'accepted', 'rejected', 'expired', 'unfunded']).optional(),
});

const BulkOfferItemSchema = z.object({
  ensNameId: z.number(),
  offerAmountWei: z.string(),
  orderData: z.any(),
  orderHash: z.string().optional(),
  signature: z.string(),
});

const CreateBulkOffersSchema = z.object({
  offers: z.array(BulkOfferItemSchema).min(2).max(500),
  buyerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  currencyAddress: z.string().optional(),
  expiresAt: z.string().optional(),
  treeHeight: z.number().int().min(1).max(24),
  merkleRoot: z.string().optional(),
});

const CreateCriteriaOfferSchema = z.object({
  buyerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  offerAmountWei: z.string(),
  tokenIds: z.array(z.string()).min(2).max(1000),
  merkleRoot: z.string(),
  orderData: z.any(),
  orderHash: z.string().optional(),
  signature: z.string(),
  currencyAddress: z.string().optional(),
  expiresAt: z.string().optional(),
});

const EditOfferSchema = z.object({
  offerAmountWei: z.string(),
  orderData: z.any(),
  orderHash: z.string().optional(),
  signature: z.string(),
  expiresAt: z.string().optional(),
});

const BulkEditOffersSchema = z.object({
  cancelOfferIds: z.array(z.number()),
  offers: z.array(BulkOfferItemSchema).min(1).max(500),
  buyerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  currencyAddress: z.string().optional(),
  expiresAt: z.string().optional(),
  treeHeight: z.number().int().min(1).max(24),
  merkleRoot: z.string().optional(),
});

const UpdateOfferLimitsSchema = z.object({
  limits: z.array(z.object({
    key: z.string(),
    value: z.string(),
  })),
});

export async function offersRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const body = CreateOfferSchema.parse(request.body);

    // Verify buyer address matches authenticated user
    if (body.buyerAddress.toLowerCase() !== request.user!.address.toLowerCase()) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Buyer address does not match authenticated user',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // Validate fee for Grails marketplace offers (offers are always 'grails' source)
    const feeValidation = validateFeeInOrder(body.orderData, 'grails');
    if (!feeValidation.valid) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INVALID_FEE',
          message: feeValidation.error || 'Invalid marketplace fee',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const query = `
      WITH inserted_offer AS (
        INSERT INTO offers (
          ens_name_id,
          buyer_address,
          offer_amount_wei,
          currency_address,
          order_data,
          status,
          expires_at
        ) VALUES ($1, $2, $3, $4, $5, 'pending', $6)
        RETURNING *
      )
      SELECT io.*, e.name, e.token_id
      FROM inserted_offer io
      JOIN ens_names e ON io.ens_name_id = e.id
    `;

    try {
      const result = await pool.query(query, [
        body.ensNameId,
        body.buyerAddress.toLowerCase(), // Normalize to lowercase
        body.offerAmountWei,
        body.currencyAddress?.toLowerCase() || '0x0000000000000000000000000000000000000000',
        JSON.stringify(body.orderData),
        body.expiresAt ? new Date(body.expiresAt) : null,
      ]);

      const offer = result.rows[0];

      // Publish queue jobs for new offer
      try {
        const { getQueueClient, QUEUE_NAMES } = await import('../queue');
        const boss = await getQueueClient();

        // Schedule expiry job if expires_at is set
        if (offer.expires_at) {
          await boss.send(
            QUEUE_NAMES.EXPIRE_ORDERS,
            { type: 'offer', id: offer.id },
            { startAfter: new Date(offer.expires_at) }
          );
          fastify.log.info({ offerId: offer.id, expiresAt: offer.expires_at }, 'Scheduled offer expiry job');
        }

        // Publish highest offer update job
        await boss.send('update-highest-offer', {
          ensNameId: offer.ens_name_id,
          offerId: offer.id,
          offerAmountWei: offer.offer_amount_wei,
          currencyAddress: offer.currency_address,
        });
        fastify.log.info({ offerId: offer.id, ensNameId: offer.ens_name_id }, 'Published highest offer update job');

        // Trigger immediate balance validation for new offer
        await boss.send('validate-offer-balance', {
          offerId: offer.id
        });
        fastify.log.info({ offerId: offer.id }, 'Triggered offer balance validation');
      } catch (queueError) {
        // Don't fail the request if queue publishing fails
        fastify.log.error({ error: queueError }, 'Failed to publish queue jobs for offer');
      }

      const response: APIResponse<Offer> = {
        success: true,
        data: offer,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.status(201).send(response);
    } catch (error: any) {
      if (error.code === '23503') {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAME_NOT_FOUND',
            message: 'ENS name not found',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      throw error;
    }
  });

  // Get offers by ENS name
  fastify.get('/name/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const { page = 1, limit = 20, status = 'pending' } = request.query as any;
    const offset = (page - 1) * limit;

    const nameQuery = `SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)`;
    const nameResult = await pool.query(nameQuery, [name]);

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'NAME_NOT_FOUND',
          message: `ENS name "${name}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const ensNameId = nameResult.rows[0].id;

    const offersQuery = `
      SELECT o.*, e.name, e.token_id
      FROM offers o
      JOIN ens_names e ON o.ens_name_id = e.id
      WHERE o.ens_name_id = $1
      ${status ? 'AND o.status = $4' : ''}
      ORDER BY o.offer_amount_wei DESC, o.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) FROM offers
      WHERE ens_name_id = $1
      ${status ? 'AND status = $2' : ''}
    `;

    const queryParams = status
      ? [ensNameId, limit, offset, status]
      : [ensNameId, limit, offset];

    const countParams = status
      ? [ensNameId, status]
      : [ensNameId];

    const [offersResult, countResult] = await Promise.all([
      pool.query(offersQuery, queryParams),
      pool.query(countQuery, countParams),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const response: APIResponse = {
      success: true,
      data: {
        offers: offersResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // Get single offer by ID
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const query = `
      SELECT o.*, e.name, e.token_id
      FROM offers o
      JOIN ens_names e ON o.ens_name_id = e.id
      WHERE o.id = $1
    `;
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'OFFER_NOT_FOUND',
          message: 'Offer not found',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse<Offer> = {
      success: true,
      data: result.rows[0],
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  fastify.put('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdateOfferSchema.parse(request.body);

    // Verify the user is authorized to update this offer
    const offerCheck = await pool.query(`
      SELECT o.buyer_address, o.status, en.owner_address
      FROM offers o
      JOIN ens_names en ON o.ens_name_id = en.id
      WHERE o.id = $1
    `, [id]);

    if (offerCheck.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'OFFER_NOT_FOUND',
          message: 'Offer not found',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const offer = offerCheck.rows[0];
    const userAddr = request.user!.address.toLowerCase();
    const isBuyer = offer.buyer_address.toLowerCase() === userAddr;
    const isOwner = offer.owner_address.toLowerCase() === userAddr;

    if (body.status === 'rejected') {
      // Only the buyer (offer creator) can reject/cancel their own offer
      if (!isBuyer) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the offer creator can cancel this offer',
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }
    } else if (body.status === 'accepted') {
      // Only the ENS name owner can accept an offer on their name
      if (!isOwner) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the ENS name owner can accept this offer',
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }
    } else {
      // For other updates, require the user to be either the buyer or the name owner
      if (!isBuyer && !isOwner) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Not authorized to update this offer',
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (body.offerAmountWei !== undefined) {
      updates.push(`offer_amount_wei = $${paramCount}`);
      values.push(body.offerAmountWei);
      paramCount++;
    }

    if (body.status !== undefined) {
      updates.push(`status = $${paramCount}`);
      values.push(body.status);
      paramCount++;
    }

    if (updates.length === 0) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'NO_UPDATES',
          message: 'No fields to update',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    values.push(id);

    const query = `
      WITH updated_offer AS (
        UPDATE offers
        SET ${updates.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      )
      SELECT uo.*, e.name, e.token_id
      FROM updated_offer uo
      JOIN ens_names e ON uo.ens_name_id = e.id
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'OFFER_NOT_FOUND',
          message: 'Offer not found',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const updatedOffer = result.rows[0];

    // Publish queue jobs based on what was updated
    try {
      const { getQueueClient } = await import('../queue');
      const boss = await getQueueClient();

      // If offer amount changed and still pending, update highest offer
      if (body.offerAmountWei !== undefined && updatedOffer.status === 'pending') {
        await boss.send('update-highest-offer', {
          ensNameId: updatedOffer.ens_name_id,
          offerId: updatedOffer.id,
          offerAmountWei: updatedOffer.offer_amount_wei,
          currencyAddress: updatedOffer.currency_address,
        });
        fastify.log.info({ offerId: updatedOffer.id }, 'Published highest offer update for amount change');
      }

      // If status changed from pending to something else, recalculate highest offer
      if (body.status !== undefined && body.status !== 'pending') {
        // Check if this might have been the highest offer
        const checkHighest = await pool.query(
          'SELECT highest_offer_id FROM ens_names WHERE id = $1',
          [updatedOffer.ens_name_id]
        );

        if (checkHighest.rows[0]?.highest_offer_id === updatedOffer.id) {
          await boss.send('recalculate-highest-offer', {
            ensNameId: updatedOffer.ens_name_id,
          });
          fastify.log.info({ offerId: updatedOffer.id, ensNameId: updatedOffer.ens_name_id }, 'Published recalculate highest offer (was highest)');
        }
      }
    } catch (queueError) {
      fastify.log.error({ error: queueError }, 'Failed to publish highest offer queue jobs');
    }

    const response: APIResponse<Offer> = {
      success: true,
      data: updatedOffer,
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // Get offers by buyer address
  fastify.get('/buyer/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const { page = 1, limit = 20, status } = request.query as any;
    const offset = (page - 1) * limit;

    const offersQuery = `
      SELECT o.*, e.name, e.token_id
      FROM offers o
      JOIN ens_names e ON o.ens_name_id = e.id
      WHERE LOWER(o.buyer_address) = LOWER($1)
      ${status ? 'AND o.status = $4' : ''}
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) FROM offers
      WHERE LOWER(buyer_address) = LOWER($1)
      ${status ? 'AND status = $2' : ''}
    `;

    const queryParams = status
      ? [address, limit, offset, status]
      : [address, limit, offset];

    const countParams = status
      ? [address, status]
      : [address];

    const [offersResult, countResult] = await Promise.all([
      pool.query(offersQuery, queryParams),
      pool.query(countQuery, countParams),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const response: APIResponse = {
      success: true,
      data: {
        offers: offersResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // Get offers received by owner address (offers on names they own)
  fastify.get('/owner/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const { page = 1, limit = 20, status } = request.query as any;
    const offset = (page - 1) * limit;

    const offersQuery = `
      SELECT o.*, e.name, e.token_id
      FROM offers o
      JOIN ens_names e ON o.ens_name_id = e.id
      WHERE LOWER(e.owner_address) = LOWER($1)
      ${status ? 'AND o.status = $4' : ''}
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) FROM offers o
      JOIN ens_names e ON o.ens_name_id = e.id
      WHERE LOWER(e.owner_address) = LOWER($1)
      ${status ? 'AND o.status = $2' : ''}
    `;

    const queryParams = status
      ? [address, limit, offset, status]
      : [address, limit, offset];

    const countParams = status
      ? [address, status]
      : [address];

    const [offersResult, countResult] = await Promise.all([
      pool.query(offersQuery, queryParams),
      pool.query(countQuery, countParams),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const response: APIResponse = {
      success: true,
      data: {
        offers: offersResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // ========================
  // Get offer limits (public with tier info)
  // ========================
  fastify.get('/limits', async (request, reply) => {
    const limits = await getOfferLimits();

    const response: APIResponse = {
      success: true,
      data: limits,
      meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };

    return reply.send(response);
  });

  // ========================
  // Bulk Cancellation
  // ========================

  /**
   * POST /api/v1/offers/cancel
   * Cancel specific offers by ID, return order data for on-chain cancellation
   */
  fastify.post(
    '/cancel',
    { preHandler: [requireAuth, requireMinTier('pro')] },
    async (request, reply) => {
      const CancelOffersSchema = z.object({
        offerIds: z.array(z.number()).min(1).max(500),
      });

      const body = CancelOffersSchema.parse(request.body);
      const buyerAddress = request.user!.address;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Cancel offers that belong to the authenticated user and are still pending
        const cancelResult = await client.query(
          `UPDATE offers SET status = 'cancelled'
           WHERE id = ANY($1) AND LOWER(buyer_address) = LOWER($2) AND status = 'pending'
           RETURNING id, ens_name_id, order_hash, order_data, bulk_offer_group_id`,
          [body.offerIds, buyerAddress]
        );

        if (cancelResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: { code: 'NO_OFFERS_FOUND', message: 'No matching pending offers found for your address' },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        // Update any bulk_offer_groups that are now fully cancelled
        const affectedGroupIds = [...new Set(
          cancelResult.rows
            .map((r: any) => r.bulk_offer_group_id)
            .filter((id: any) => id != null)
        )];

        let groupsCancelled: number[] = [];
        if (affectedGroupIds.length > 0) {
          const groupUpdateResult = await client.query(
            `UPDATE bulk_offer_groups SET status = 'cancelled', cancelled_at = NOW()
             WHERE id = ANY($1)
               AND NOT EXISTS (
                 SELECT 1 FROM offers WHERE bulk_offer_group_id = bulk_offer_groups.id AND status = 'pending'
               )
             RETURNING id`,
            [affectedGroupIds]
          );
          groupsCancelled = groupUpdateResult.rows.map((r: any) => r.id);
        }

        await client.query('COMMIT');

        // Publish recalculate-highest-offer jobs for affected ENS names
        try {
          const { getQueueClient } = await import('../queue');
          const boss = await getQueueClient();

          const ensNameIds = [...new Set(cancelResult.rows.map((r: any) => r.ens_name_id))];
          const jobs = ensNameIds.map((ensNameId) => ({
            name: 'recalculate-highest-offer',
            data: { ensNameId },
          }));
          if (jobs.length > 0) await boss.insert(jobs);
        } catch (queueError) {
          fastify.log.error({ error: queueError }, 'Failed to publish recalculate jobs for cancel');
        }

        const orderComponents = cancelResult.rows.map((r: any) => ({
          offerId: r.id,
          orderHash: r.order_hash,
          orderData: r.order_data,
        }));

        const response: APIResponse = {
          success: true,
          data: {
            cancelledCount: cancelResult.rows.length,
            orderComponents,
            groupsAffected: groupsCancelled,
          },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  /**
   * POST /api/v1/offers/cancel-all
   * Cancel all pending offers for the authenticated user
   */
  fastify.post(
    '/cancel-all',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const buyerAddress = request.user!.address;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Cancel all pending offers for this user
        const cancelResult = await client.query(
          `UPDATE offers SET status = 'cancelled'
           WHERE LOWER(buyer_address) = LOWER($1) AND status = 'pending'
           RETURNING id, ens_name_id, order_hash, order_data, bulk_offer_group_id`,
          [buyerAddress]
        );

        // Cancel all active bulk_offer_groups for this user
        const groupResult = await client.query(
          `UPDATE bulk_offer_groups SET status = 'cancelled', cancelled_at = NOW()
           WHERE LOWER(buyer_address) = LOWER($1) AND status = 'active'
           RETURNING id`,
          [buyerAddress]
        );

        await client.query('COMMIT');

        // Publish recalculate-highest-offer jobs for affected ENS names
        try {
          const { getQueueClient } = await import('../queue');
          const boss = await getQueueClient();

          const ensNameIds = [...new Set(cancelResult.rows.map((r: any) => r.ens_name_id))];
          const jobs = ensNameIds.map((ensNameId) => ({
            name: 'recalculate-highest-offer',
            data: { ensNameId },
          }));
          if (jobs.length > 0) await boss.insert(jobs);
        } catch (queueError) {
          fastify.log.error({ error: queueError }, 'Failed to publish recalculate jobs for cancel-all');
        }

        const orderComponents = cancelResult.rows.map((r: any) => ({
          offerId: r.id,
          orderHash: r.order_hash,
          orderData: r.order_data,
        }));

        const response: APIResponse = {
          success: true,
          data: {
            cancelledCount: cancelResult.rows.length,
            orderComponents,
            groupsCancelled: groupResult.rows.map((r: any) => r.id),
          },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  // ========================
  // Bulk Offers (Mode 1: Shotgun) — PRO only
  // ========================

  /**
   * POST /api/v1/offers/bulk
   * Create multiple offers at once (up to 500)
   */
  fastify.post(
    '/bulk',
    { preHandler: [requireAuth, requireMinTier('pro')] },
    async (request, reply) => {
      const body = CreateBulkOffersSchema.parse(request.body);
      const buyerAddress = body.buyerAddress.toLowerCase();

      // Validate limits
      const limitError = await validateBulkOfferLimits({
        offerCount: body.offers.length,
        buyerAddress,
        offerAmounts: body.offers.map((o) => o.offerAmountWei),
      });

      if (limitError) {
        return reply.status(400).send({
          success: false,
          error: { code: 'LIMIT_EXCEEDED', message: limitError },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // Validate fees in each order
      for (let i = 0; i < body.offers.length; i++) {
        const feeValidation = validateFeeInOrder(body.offers[i].orderData, 'grails');
        if (!feeValidation.valid) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'INVALID_FEE',
              message: `Offer ${i}: ${feeValidation.error || 'Invalid marketplace fee'}`,
            },
            meta: { timestamp: new Date().toISOString() },
          });
        }
      }

      // Batch-verify ENS names exist
      const ensNameIds = body.offers.map((o) => o.ensNameId);
      const namesResult = await pool.query(
        'SELECT id FROM ens_names WHERE id = ANY($1)',
        [ensNameIds]
      );
      const existingIds = new Set(namesResult.rows.map((r: any) => r.id));
      const missingIds = ensNameIds.filter((id) => !existingIds.has(id));

      if (missingIds.length > 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'ENS_NAMES_NOT_FOUND',
            message: `ENS name IDs not found: ${missingIds.join(', ')}`,
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // Calculate total amount
      const totalAmountWei = body.offers
        .reduce((sum, o) => sum + BigInt(o.offerAmountWei), 0n)
        .toString();

      const currencyAddress =
        body.currencyAddress?.toLowerCase() ||
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'; // WETH

      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Insert bulk offer group
        const groupResult = await client.query(
          `INSERT INTO bulk_offer_groups
           (buyer_address, offer_count, tree_height, merkle_root, total_amount_wei, currency_address, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
           RETURNING id`,
          [
            buyerAddress,
            body.offers.length,
            body.treeHeight,
            body.merkleRoot || null,
            totalAmountWei,
            currencyAddress,
            expiresAt,
          ]
        );
        const groupId = groupResult.rows[0].id;

        // Batch insert offers
        const results: any[] = [];
        const errors: any[] = [];

        for (let i = 0; i < body.offers.length; i++) {
          const offerItem = body.offers[i];
          try {
            const offerResult = await client.query(
              `INSERT INTO offers
               (ens_name_id, buyer_address, offer_amount_wei, currency_address,
                order_data, order_hash, status, expires_at,
                bulk_offer_group_id, bulk_order_index, offer_type)
               VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, 'bulk')
               RETURNING id, ens_name_id`,
              [
                offerItem.ensNameId,
                buyerAddress,
                offerItem.offerAmountWei,
                currencyAddress,
                JSON.stringify(offerItem.orderData),
                offerItem.orderHash || null,
                expiresAt,
                groupId,
                i,
              ]
            );
            results.push({ index: i, offerId: offerResult.rows[0].id, ensNameId: offerResult.rows[0].ens_name_id });
          } catch (err: any) {
            errors.push({ index: i, ensNameId: offerItem.ensNameId, error: err.message });
          }
        }

        // Auto-cancel existing pending offers from same buyer on same names
        const insertedEnsNameIds = results.map((r) => r.ensNameId);
        const insertedOfferIds = results.map((r) => r.offerId);
        if (insertedEnsNameIds.length > 0) {
          await client.query(
            `UPDATE offers
             SET status = 'cancelled'
             WHERE LOWER(buyer_address) = LOWER($1)
               AND ens_name_id = ANY($2)
               AND status = 'pending'
               AND id != ALL($3)`,
            [buyerAddress, insertedEnsNameIds, insertedOfferIds]
          );
        }

        await client.query('COMMIT');

        // Publish queue jobs (outside transaction)
        try {
          const { getQueueClient, QUEUE_NAMES } = await import('../queue');
          const boss = await getQueueClient();

          // Batch schedule expiry jobs
          if (expiresAt) {
            const expiryJobs = results.map((r) => ({
              name: QUEUE_NAMES.EXPIRE_ORDERS,
              data: { type: 'offer' as const, id: r.offerId },
              options: { startAfter: expiresAt },
            }));
            await boss.insert(expiryJobs);
          }

          // Batch publish highest offer update jobs (deduped by singletonKey)
          const uniqueEnsNameIds = [...new Set(insertedEnsNameIds)];
          const highestOfferJobs = uniqueEnsNameIds.map((ensNameId) => ({
            name: 'update-highest-offer',
            data: { ensNameId },
            options: { singletonKey: `highest-offer-${ensNameId}` },
          }));
          await boss.insert(highestOfferJobs);

          // Trigger batch balance validation
          const validationJobs = results.map((r) => ({
            name: 'validate-offer-balance',
            data: { offerId: r.offerId },
          }));
          await boss.insert(validationJobs);
        } catch (queueError) {
          fastify.log.error({ error: queueError }, 'Failed to publish queue jobs for bulk offers');
        }

        // 207 multi-status response
        const response: APIResponse = {
          success: true,
          data: {
            groupId,
            totalOffers: body.offers.length,
            created: results.length,
            failed: errors.length,
            results,
            errors: errors.length > 0 ? errors : undefined,
          },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.status(errors.length > 0 ? 207 : 201).send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  /**
   * DELETE /api/v1/offers/bulk/:groupId
   * Cancel all offers in a bulk group
   */
  fastify.delete(
    '/bulk/:groupId',
    { preHandler: [requireAuth, requireMinTier('pro')] },
    async (request, reply) => {
      const { groupId } = request.params as { groupId: string };
      const buyerAddress = request.user!.address;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Verify ownership
        const groupResult = await client.query(
          'SELECT * FROM bulk_offer_groups WHERE id = $1 AND LOWER(buyer_address) = LOWER($2)',
          [groupId, buyerAddress]
        );

        if (groupResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: { code: 'GROUP_NOT_FOUND', message: 'Bulk offer group not found' },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        // Cancel all pending offers in group
        const cancelResult = await client.query(
          `UPDATE offers SET status = 'cancelled'
           WHERE bulk_offer_group_id = $1 AND status = 'pending'
           RETURNING id, ens_name_id, order_hash, order_data`,
          [groupId]
        );

        // Update group status
        await client.query(
          `UPDATE bulk_offer_groups SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
          [groupId]
        );

        await client.query('COMMIT');

        // Recalculate highest offers for affected names
        try {
          const { getQueueClient } = await import('../queue');
          const boss = await getQueueClient();

          const ensNameIds = [...new Set(cancelResult.rows.map((r: any) => r.ens_name_id))];
          const jobs = ensNameIds.map((ensNameId) => ({
            name: 'recalculate-highest-offer',
            data: { ensNameId },
          }));
          if (jobs.length > 0) await boss.insert(jobs);
        } catch (queueError) {
          fastify.log.error({ error: queueError }, 'Failed to publish recalculate jobs');
        }

        const orderComponents = cancelResult.rows.map((r: any) => ({
          offerId: r.id,
          orderHash: r.order_hash,
          orderData: r.order_data,
        }));

        const response: APIResponse = {
          success: true,
          data: { groupId: parseInt(groupId), cancelledCount: cancelResult.rows.length, orderComponents },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  /**
   * GET /api/v1/offers/bulk/:groupId
   * Get bulk offer group + offers
   */
  fastify.get('/bulk/:groupId', async (request, reply) => {
    const { groupId } = request.params as { groupId: string };

    const groupResult = await pool.query(
      'SELECT * FROM bulk_offer_groups WHERE id = $1',
      [groupId]
    );

    if (groupResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'GROUP_NOT_FOUND', message: 'Bulk offer group not found' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const offersResult = await pool.query(
      `SELECT o.*, e.name, e.token_id
       FROM offers o
       JOIN ens_names e ON o.ens_name_id = e.id
       WHERE o.bulk_offer_group_id = $1
       ORDER BY o.bulk_order_index`,
      [groupId]
    );

    const response: APIResponse = {
      success: true,
      data: {
        group: groupResult.rows[0],
        offers: offersResult.rows,
      },
      meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };

    return reply.send(response);
  });

  /**
   * GET /api/v1/offers/bulk/buyer/:address
   * List buyer's bulk groups
   */
  fastify.get('/bulk/buyer/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const { page = 1, limit = 20, status } = request.query as any;
    const offset = (page - 1) * limit;

    const statusFilter = status ? 'AND status = $4' : '';
    const params: any[] = [address.toLowerCase(), limit, offset];
    if (status) params.push(status);

    const groupsResult = await pool.query(
      `SELECT * FROM bulk_offer_groups
       WHERE LOWER(buyer_address) = $1 ${statusFilter}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    const countParams: any[] = [address.toLowerCase()];
    if (status) countParams.push(status);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM bulk_offer_groups
       WHERE LOWER(buyer_address) = $1 ${status ? 'AND status = $2' : ''}`,
      countParams
    );

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const response: APIResponse = {
      success: true,
      data: {
        groups: groupsResult.rows,
        pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
      },
      meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };

    return reply.send(response);
  });

  // ========================
  // Criteria Offers (Mode 2: Pick-One) — PRO only
  // ========================

  /**
   * POST /api/v1/offers/criteria
   * Create a criteria-based (pick-one) offer
   */
  fastify.post(
    '/criteria',
    { preHandler: [requireAuth, requireMinTier('pro')] },
    async (request, reply) => {
      const body = CreateCriteriaOfferSchema.parse(request.body);
      const buyerAddress = body.buyerAddress.toLowerCase();

      // Check limits
      const limits = await getOfferLimits();
      if (!limits.bulk_offers_enabled) {
        return reply.status(400).send({
          success: false,
          error: { code: 'DISABLED', message: 'Bulk/criteria offers are currently disabled' },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      if (body.tokenIds.length > limits.max_criteria_offer_names) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'LIMIT_EXCEEDED',
            message: `Maximum ${limits.max_criteria_offer_names} names in a criteria offer`,
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      if (BigInt(body.offerAmountWei) < BigInt(limits.min_offer_amount_wei)) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'AMOUNT_TOO_LOW',
            message: `Minimum offer amount is ${limits.min_offer_amount_wei} wei`,
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const currencyAddress =
        body.currencyAddress?.toLowerCase() ||
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

      // We need an ens_name_id — use the first token in the set.
      // Look up by token_id to find the ens_name
      const firstNameResult = await pool.query(
        'SELECT id FROM ens_names WHERE token_id = $1',
        [body.tokenIds[0]]
      );

      if (firstNameResult.rows.length === 0) {
        return reply.status(400).send({
          success: false,
          error: { code: 'TOKEN_NOT_FOUND', message: `Token ID ${body.tokenIds[0]} not found` },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Insert the offer
        const offerResult = await client.query(
          `INSERT INTO offers
           (ens_name_id, buyer_address, offer_amount_wei, currency_address,
            order_data, order_hash, status, expires_at, offer_type)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, 'criteria')
           RETURNING id`,
          [
            firstNameResult.rows[0].id,
            buyerAddress,
            body.offerAmountWei,
            currencyAddress,
            JSON.stringify(body.orderData),
            body.orderHash || null,
            expiresAt,
          ]
        );
        const offerId = offerResult.rows[0].id;

        // Insert criteria data
        await client.query(
          `INSERT INTO criteria_offers (offer_id, token_ids, merkle_root)
           VALUES ($1, $2, $3)`,
          [offerId, body.tokenIds, body.merkleRoot]
        );

        await client.query('COMMIT');

        // Publish queue jobs
        try {
          const { getQueueClient, QUEUE_NAMES } = await import('../queue');
          const boss = await getQueueClient();

          if (expiresAt) {
            await boss.send(QUEUE_NAMES.EXPIRE_ORDERS, { type: 'offer', id: offerId }, { startAfter: expiresAt });
          }

          await boss.send('validate-offer-balance', { offerId });
        } catch (queueError) {
          fastify.log.error({ error: queueError }, 'Failed to publish queue jobs for criteria offer');
        }

        const response: APIResponse = {
          success: true,
          data: { offerId, merkleRoot: body.merkleRoot, tokenCount: body.tokenIds.length },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.status(201).send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  /**
   * DELETE /api/v1/offers/criteria/:id
   * Cancel a criteria offer
   */
  fastify.delete(
    '/criteria/:id',
    { preHandler: [requireAuth, requireMinTier('pro')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const buyerAddress = request.user!.address;

      const result = await pool.query(
        `UPDATE offers SET status = 'cancelled'
         WHERE id = $1 AND LOWER(buyer_address) = LOWER($2) AND status = 'pending' AND offer_type = 'criteria'
         RETURNING id`,
        [id, buyerAddress]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: { code: 'OFFER_NOT_FOUND', message: 'Criteria offer not found or already cancelled' },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const response: APIResponse = {
        success: true,
        data: { offerId: parseInt(id), cancelled: true },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      };

      return reply.send(response);
    }
  );

  /**
   * GET /api/v1/offers/criteria/:id/proof/:tokenId
   * Get merkle proof for fulfilling a criteria offer
   */
  fastify.get('/criteria/:id/proof/:tokenId', async (request, reply) => {
    const { id, tokenId } = request.params as { id: string; tokenId: string };

    const criteriaResult = await pool.query(
      `SELECT co.*, o.status
       FROM criteria_offers co
       JOIN offers o ON co.offer_id = o.id
       WHERE co.offer_id = $1`,
      [id]
    );

    if (criteriaResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'CRITERIA_OFFER_NOT_FOUND', message: 'Criteria offer not found' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const criteria = criteriaResult.rows[0];

    if (!criteria.token_ids.includes(tokenId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'TOKEN_NOT_IN_SET', message: 'Token ID is not in the criteria set' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // Rebuild merkle tree to generate proof (inline to avoid SDK dependency)
    const { keccak256, encodePacked } = await import('viem');

    function hashTokenIdLeaf(tid: string): string {
      return keccak256(encodePacked(['uint256'], [BigInt(tid)]));
    }

    function hashSortedPairLocal(a: string, b: string): string {
      if (a.toLowerCase() <= b.toLowerCase()) {
        return keccak256(encodePacked(['bytes32', 'bytes32'], [a as `0x${string}`, b as `0x${string}`]));
      }
      return keccak256(encodePacked(['bytes32', 'bytes32'], [b as `0x${string}`, a as `0x${string}`]));
    }

    const hashedLeaves = criteria.token_ids.map((tid: string) => ({
      tokenId: tid,
      hash: hashTokenIdLeaf(tid),
    }));
    hashedLeaves.sort((a: any, b: any) => a.hash.toLowerCase().localeCompare(b.hash.toLowerCase()));

    const leafHashes = hashedLeaves.map((l: any) => l.hash);
    // Pad to power of 2
    let padded = leafHashes.length;
    while (padded & (padded - 1)) padded++;
    if (padded < leafHashes.length) padded = leafHashes.length;
    while (leafHashes.length < padded) leafHashes.push('0x' + '00'.repeat(32));

    // Build tree layers
    const layers: string[][] = [leafHashes];
    let cur = leafHashes;
    while (cur.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < cur.length; i += 2) {
        next.push(hashSortedPairLocal(cur[i], cur[i + 1]));
      }
      layers.push(next);
      cur = next;
    }

    // Find leaf index for requested token
    const leafIndex = hashedLeaves.findIndex((l: any) => l.tokenId === tokenId);
    const proof: string[] = [];
    let idx = leafIndex;
    for (let i = 0; i < layers.length - 1; i++) {
      const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sibIdx < layers[i].length) proof.push(layers[i][sibIdx]);
      idx = Math.floor(idx / 2);
    }

    const response: APIResponse = {
      success: true,
      data: { proof, merkleRoot: criteria.merkle_root, tokenId },
      meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };

    return reply.send(response);
  });

  // ========================
  // Edit Offers — PRO only
  // ========================

  /**
   * PUT /api/v1/offers/:id/edit
   * Edit offer (cancel old + create new with new signature)
   */
  fastify.put(
    '/:id/edit',
    { preHandler: [requireAuth, requireMinTier('pro')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = EditOfferSchema.parse(request.body);
      const buyerAddress = request.user!.address;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Cancel old offer
        const oldResult = await client.query(
          `UPDATE offers SET status = 'cancelled'
           WHERE id = $1 AND LOWER(buyer_address) = LOWER($2) AND status = 'pending'
           RETURNING ens_name_id, currency_address, offer_type`,
          [id, buyerAddress]
        );

        if (oldResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: { code: 'OFFER_NOT_FOUND', message: 'Offer not found or already cancelled' },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        const old = oldResult.rows[0];
        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

        // Create new offer
        const newResult = await client.query(
          `INSERT INTO offers
           (ens_name_id, buyer_address, offer_amount_wei, currency_address,
            order_data, order_hash, status, expires_at, offer_type)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
           RETURNING *`,
          [
            old.ens_name_id,
            buyerAddress.toLowerCase(),
            body.offerAmountWei,
            old.currency_address,
            JSON.stringify(body.orderData),
            body.orderHash || null,
            expiresAt,
            old.offer_type || 'individual',
          ]
        );

        await client.query('COMMIT');

        const newOffer = newResult.rows[0];

        // Publish queue jobs
        try {
          const { getQueueClient, QUEUE_NAMES } = await import('../queue');
          const boss = await getQueueClient();

          if (expiresAt) {
            await boss.send(QUEUE_NAMES.EXPIRE_ORDERS, { type: 'offer', id: newOffer.id }, { startAfter: expiresAt });
          }

          await boss.send('update-highest-offer', { ensNameId: newOffer.ens_name_id });
          await boss.send('validate-offer-balance', { offerId: newOffer.id });
        } catch (queueError) {
          fastify.log.error({ error: queueError }, 'Failed to publish queue jobs for edited offer');
        }

        const response: APIResponse = {
          success: true,
          data: { cancelledOfferId: parseInt(id), newOffer },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  /**
   * PUT /api/v1/offers/bulk/edit
   * Bulk edit: cancel old offers + create new bulk offers
   */
  fastify.put(
    '/bulk/edit',
    { preHandler: [requireAuth, requireMinTier('pro')] },
    async (request, reply) => {
      const body = BulkEditOffersSchema.parse(request.body);
      const buyerAddress = body.buyerAddress.toLowerCase();

      // Validate limits
      const limitError = await validateBulkOfferLimits({
        offerCount: body.offers.length,
        buyerAddress,
        offerAmounts: body.offers.map((o) => o.offerAmountWei),
      });

      if (limitError) {
        return reply.status(400).send({
          success: false,
          error: { code: 'LIMIT_EXCEEDED', message: limitError },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Cancel old offers
        if (body.cancelOfferIds.length > 0) {
          await client.query(
            `UPDATE offers SET status = 'cancelled'
             WHERE id = ANY($1) AND LOWER(buyer_address) = LOWER($2) AND status = 'pending'`,
            [body.cancelOfferIds, buyerAddress]
          );
        }

        // Calculate total
        const totalAmountWei = body.offers
          .reduce((sum, o) => sum + BigInt(o.offerAmountWei), 0n)
          .toString();
        const currencyAddress =
          body.currencyAddress?.toLowerCase() || '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

        // Create new bulk group
        const groupResult = await client.query(
          `INSERT INTO bulk_offer_groups
           (buyer_address, offer_count, tree_height, merkle_root, total_amount_wei, currency_address, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
           RETURNING id`,
          [buyerAddress, body.offers.length, body.treeHeight, body.merkleRoot || null, totalAmountWei, currencyAddress, expiresAt]
        );
        const groupId = groupResult.rows[0].id;

        // Insert new offers
        const results: any[] = [];
        for (let i = 0; i < body.offers.length; i++) {
          const item = body.offers[i];
          const r = await client.query(
            `INSERT INTO offers
             (ens_name_id, buyer_address, offer_amount_wei, currency_address,
              order_data, order_hash, status, expires_at,
              bulk_offer_group_id, bulk_order_index, offer_type)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, 'bulk')
             RETURNING id, ens_name_id`,
            [item.ensNameId, buyerAddress, item.offerAmountWei, currencyAddress,
             JSON.stringify(item.orderData), item.orderHash || null, expiresAt, groupId, i]
          );
          results.push({ index: i, offerId: r.rows[0].id, ensNameId: r.rows[0].ens_name_id });
        }

        await client.query('COMMIT');

        // Publish queue jobs
        try {
          const { getQueueClient, QUEUE_NAMES } = await import('../queue');
          const boss = await getQueueClient();

          if (expiresAt) {
            const expiryJobs = results.map((r) => ({
              name: QUEUE_NAMES.EXPIRE_ORDERS,
              data: { type: 'offer' as const, id: r.offerId },
              options: { startAfter: expiresAt },
            }));
            await boss.insert(expiryJobs);
          }

          const ensNameIds = [...new Set(results.map((r) => r.ensNameId))];
          const highestOfferJobs = ensNameIds.map((ensNameId) => ({
            name: 'update-highest-offer',
            data: { ensNameId },
          }));
          await boss.insert(highestOfferJobs);
        } catch (queueError) {
          fastify.log.error({ error: queueError }, 'Failed to publish queue jobs for bulk edit');
        }

        const response: APIResponse = {
          success: true,
          data: {
            cancelledCount: body.cancelOfferIds.length,
            groupId,
            created: results.length,
            results,
          },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  // ========================
  // Admin — Offer Limits
  // ========================

  /**
   * PUT /api/v1/offers/admin/limits
   * Update global offer limits
   */
  fastify.put(
    '/admin/limits',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const body = UpdateOfferLimitsSchema.parse(request.body);

      for (const { key, value } of body.limits) {
        await pool.query(
          `UPDATE offer_limits SET value = $2, updated_at = NOW() WHERE key = $1`,
          [key, value]
        );
      }

      invalidateOfferLimitsCache();

      const response: APIResponse = {
        success: true,
        data: { updated: body.limits.length },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      };

      return reply.send(response);
    }
  );
}
