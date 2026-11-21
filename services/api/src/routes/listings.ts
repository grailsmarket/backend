import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse, type Listing, sqlWithinGracePeriod, ensNameIdForName } from '../../../shared/src';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { applyCompromisedToListingRows } from '../services/compromised-names';

const UpdateListingSchema = z.object({
  priceWei: z.string().optional(),
  expiresAt: z.string().optional(),
});

const ListListingsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: z.enum(['active', 'sold', 'cancelled', 'expired', 'unfunded']).optional(),
  seller: z.string().optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  sort: z.enum(['price', 'created', 'expiry', 'name']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Helper function to get clubs for an ENS name
 */
async function getClubsForEnsName(pool: any, ensNameId: number): Promise<string[]> {
  const result = await pool.query(
    'SELECT clubs FROM ens_names WHERE id = $1',
    [ensNameId]
  );
  return result.rows[0]?.clubs || [];
}

export async function listingsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // GET all listings with filtering and pagination
  fastify.get('/', { preHandler: optionalAuth }, async (request, reply) => {
    const query = ListListingsQuerySchema.parse(request.query);
    fastify.log.info(`GET /listings - page=${query.page}, limit=${query.limit}, status=${query.status}`);
    const offset = (query.page - 1) * query.limit;

    let whereConditions: string[] = [];
    let params: any[] = [];
    let paramCount = 1;

    // Exclude names past grace period (90 days after expiry)
    // Allow: non-expired names, names in grace period, and subnames (no expiry date)
    whereConditions.push(`(en.expiry_date IS NULL OR ${sqlWithinGracePeriod('en')})`);

    // Always include status filter, default to active if not specified
    const statusFilter = query.status || 'active';
    whereConditions.push(`l.status = $${paramCount}`);
    params.push(statusFilter);
    paramCount++;

    // If filtering for active listings, also exclude expired ones based on expires_at
    if (statusFilter === 'active') {
      whereConditions.push(`(l.expires_at IS NULL OR l.expires_at > NOW())`);
    }

    if (query.seller) {
      whereConditions.push(`l.seller_address = $${paramCount}`);
      params.push(query.seller.toLowerCase());
      paramCount++;
    }

    if (query.minPrice) {
      whereConditions.push(`CAST(l.price_wei AS NUMERIC) >= $${paramCount}`);
      params.push(query.minPrice);
      paramCount++;
    }

    if (query.maxPrice) {
      whereConditions.push(`CAST(l.price_wei AS NUMERIC) <= $${paramCount}`);
      params.push(query.maxPrice);
      paramCount++;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const orderByMap: { [key: string]: string } = {
      price: 'CAST(l.price_wei AS NUMERIC)',
      created: 'l.created_at',
      expiry: 'l.expires_at',
      name: 'en.name',
    };

    const orderBy = `${orderByMap[query.sort]} ${query.order.toUpperCase()} NULLS LAST`;

    // Count query
    const countQuery = `
      SELECT COUNT(*)
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      ${whereClause}
    `;

    // Data query with ENS name details
    const dataQuery = `
      SELECT
        l.*,
        en.name as ens_name,
        en.token_id,
        en.owner_address as current_owner,
        en.expiry_date as name_expiry_date,
        en.registration_date,
        en.last_sale_date
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;

    params.push(query.limit, offset);

    try {
      const [countResult, dataResult] = await Promise.all([
        pool.query(countQuery, params.slice(0, -2)),
        pool.query(dataQuery, params),
      ]);

      const total = parseInt(countResult.rows[0].count);
      const totalPages = Math.ceil(total / query.limit);

      fastify.log.info(`Regular listings pagination: page=${query.page}, total=${total}, totalPages=${totalPages}, hasNext=${query.page < totalPages}`);

      const response: APIResponse<{
        listings: any[];
        pagination: any;
      }> = {
        success: true,
        data: {
          listings: await applyCompromisedToListingRows(dataResult.rows, request.user?.address),
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages,
            hasNext: query.page < totalPages,
            hasPrev: query.page > 1,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching listings:', error);
      throw error;
    }
  });

  // GET listing by ENS name (returns all active listings for the name)
  fastify.get('/name/:name', { preHandler: optionalAuth }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const query = `
      SELECT
        l.*,
        en.name as ens_name,
        en.token_id,
        en.owner_address as current_owner,
        en.expiry_date as name_expiry_date,
        en.registration_date,
        en.last_sale_date
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      WHERE en.id = ${ensNameIdForName('$1')}
      AND l.status = 'active'
      ORDER BY l.created_at DESC
    `;

    const result = await pool.query(query, [name]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: `No active listing found for "${name}"`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse<any> = {
      success: true,
      data: await applyCompromisedToListingRows(result.rows, request.user?.address),
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // GET listing by ID
  fastify.get('/:id', { preHandler: optionalAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const query = `
      SELECT
        l.*,
        en.name as ens_name,
        en.token_id,
        en.owner_address as current_owner,
        en.expiry_date as name_expiry_date,
        en.registration_date,
        en.last_sale_date
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      WHERE l.id = $1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: `Listing with ID "${id}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse<any> = {
      success: true,
      data: (await applyCompromisedToListingRows(result.rows, request.user?.address))[0],
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // Listings are created through POST /orders/bulk, /orders or /brokered-listings, which verify
  // the Seaport order (services/order-verification.ts).
  fastify.post('/', async (_request, reply) => {
    return reply.status(410).send({
      success: false,
      error: {
        code: 'ENDPOINT_REMOVED',
        message: 'POST /listings has been removed. Create listings with POST /api/v1/orders/bulk and a signed Seaport order.',
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  fastify.put('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdateListingSchema.parse(request.body);

    // The price is part of the signed Seaport order, so it can't be edited
    if (body.priceWei !== undefined) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'PRICE_NOT_EDITABLE',
          message: 'The price is part of the signed order. Cancel the listing and create a new one to change it.',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // Verify the listing belongs to the authenticated user
    const ownerCheck = await pool.query(
      'SELECT seller_address FROM listings WHERE id = $1 AND status = $2',
      [id, 'active']
    );
    if (ownerCheck.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: 'Active listing not found',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    if (ownerCheck.rows[0].seller_address.toLowerCase() !== request.user!.address.toLowerCase()) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only the listing seller can update this listing',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (body.expiresAt !== undefined) {
      updates.push(`expires_at = $${paramCount}`);
      values.push(new Date(body.expiresAt));
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
      UPDATE listings
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramCount}
      AND status = 'active'
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: 'Active listing not found',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const updatedListing = result.rows[0];

    const response: APIResponse<Listing> = {
      success: true,
      data: updatedListing,
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  fastify.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    // Verify the listing belongs to the authenticated user
    const ownerCheck = await pool.query(
      'SELECT seller_address FROM listings WHERE id = $1 AND status = $2',
      [id, 'active']
    );
    if (ownerCheck.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: 'Active listing not found',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    if (ownerCheck.rows[0].seller_address.toLowerCase() !== request.user!.address.toLowerCase()) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only the listing seller can cancel this listing',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const query = `
      UPDATE listings
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
      AND status = 'active'
      RETURNING *
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: 'Active listing not found',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const cancelledListing = result.rows[0];

    // Recalculate club floor price since a listing was removed
    try {
      const { getQueueClient } = await import('../queue');
      const boss = await getQueueClient();
      const clubs = await getClubsForEnsName(pool, cancelledListing.ens_name_id);

      if (clubs.length > 0) {
        await boss.send('update-club-floor-price', {
          clubNames: clubs,
          eventType: 'delete',
          listingPrice: cancelledListing.price_wei,
        });
        fastify.log.info({ clubs }, 'Scheduled club floor price recalculation after listing cancellation');
      }
    } catch (queueError) {
      fastify.log.error({ error: queueError }, 'Failed to publish club stats job for listing cancellation');
    }

    const response: APIResponse = {
      success: true,
      data: {
        message: 'Listing cancelled successfully',
        listing: cancelledListing,
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}