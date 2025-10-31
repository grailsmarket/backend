import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, Listing } from '../../../shared/src';

const CreateListingSchema = z.object({
  ensNameId: z.number(),
  sellerAddress: z.string(),
  priceWei: z.string(),
  currencyAddress: z.string().optional(),
  orderData: z.any(),
  expiresAt: z.string().optional(),
});

const UpdateListingSchema = z.object({
  priceWei: z.string().optional(),
  expiresAt: z.string().optional(),
});

const ListListingsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: z.enum(['active', 'sold', 'cancelled', 'expired']).optional(),
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
  fastify.get('/', async (request, reply) => {
    const query = ListListingsQuerySchema.parse(request.query);
    fastify.log.info(`GET /listings - page=${query.page}, limit=${query.limit}, status=${query.status}`);
    const offset = (query.page - 1) * query.limit;

    let whereConditions: string[] = [];
    let params: any[] = [];
    let paramCount = 1;

    // Always include status filter, default to active if not specified
    const statusFilter = query.status || 'active';
    whereConditions.push(`l.status = $${paramCount}`);
    params.push(statusFilter);
    paramCount++;

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
          listings: dataResult.rows,
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
  fastify.get('/name/:name', async (request, reply) => {
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
      WHERE LOWER(en.name) = LOWER($1)
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
      data: result.rows,
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // GET listing by ID
  fastify.get('/:id', async (request, reply) => {
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
      data: result.rows[0],
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  fastify.post('/', async (request, reply) => {
    const body = CreateListingSchema.parse(request.body);

    const query = `
      INSERT INTO listings (
        ens_name_id,
        seller_address,
        price_wei,
        currency_address,
        order_data,
        status,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [
        body.ensNameId,
        body.sellerAddress.toLowerCase(), // Normalize to lowercase
        body.priceWei,
        body.currencyAddress?.toLowerCase() || '0x0000000000000000000000000000000000000000',
        JSON.stringify(body.orderData),
        body.expiresAt ? new Date(body.expiresAt) : null,
      ]);

      const listing = result.rows[0];

      // Publish queue jobs for new listing
      try {
        const { getQueueClient, QUEUE_NAMES } = await import('../queue');
        const boss = await getQueueClient();

        // 1. Schedule expiry job if expires_at is set
        if (listing.expires_at) {
          await boss.send(
            QUEUE_NAMES.EXPIRE_ORDERS,
            { type: 'listing', id: listing.id },
            { startAfter: new Date(listing.expires_at) }
          );
          fastify.log.info({ listingId: listing.id, expiresAt: listing.expires_at }, 'Scheduled expiry job');
        }

        // 2. Trigger immediate ENS metadata sync
        const ensNameResult = await pool.query(
          'SELECT token_id FROM ens_names WHERE id = $1',
          [body.ensNameId]
        );

        if (ensNameResult.rows.length > 0) {
          await boss.send(QUEUE_NAMES.SYNC_ENS_DATA, {
            ensNameId: body.ensNameId,
            nameHash: ensNameResult.rows[0].token_id,
            priority: 'high',
          });
          fastify.log.info({ ensNameId: body.ensNameId }, 'Scheduled ENS sync job');
        }

        // 3. Update club floor price if this ENS name is in any clubs
        const clubs = await getClubsForEnsName(pool, body.ensNameId);
        if (clubs.length > 0) {
          await boss.send('update-club-floor-price', {
            clubNames: clubs,
            eventType: 'create',
            listingPrice: body.priceWei,
          });
          fastify.log.info({ clubs, listingPrice: body.priceWei }, 'Scheduled club floor price update');
        }
      } catch (queueError) {
        // Don't fail the request if queue publishing fails
        fastify.log.error({ error: queueError }, 'Failed to publish queue jobs for listing');
      }

      const response: APIResponse<Listing> = {
        success: true,
        data: listing,
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

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdateListingSchema.parse(request.body);

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (body.priceWei !== undefined) {
      updates.push(`price_wei = $${paramCount}`);
      values.push(body.priceWei);
      paramCount++;
    }

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

    // Update club floor price if price was changed
    if (body.priceWei !== undefined) {
      try {
        const { getQueueClient } = await import('../queue');
        const boss = await getQueueClient();
        const clubs = await getClubsForEnsName(pool, updatedListing.ens_name_id);

        if (clubs.length > 0) {
          await boss.send('update-club-floor-price', {
            clubNames: clubs,
            eventType: 'update',
            listingPrice: body.priceWei,
          });
          fastify.log.info({ clubs, listingPrice: body.priceWei }, 'Scheduled club floor price update after price change');
        }
      } catch (queueError) {
        fastify.log.error({ error: queueError }, 'Failed to publish club stats job for listing update');
      }
    }

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

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

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
        meta: {
          timestamp: new Date().toISOString(),
        },
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