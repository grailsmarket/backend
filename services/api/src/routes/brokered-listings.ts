import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPostgresPool,
  getBrokerFeeConfig,
  validateBrokeredListingFees,
} from '../../../shared/src';
import { buildSearchResults } from '../utils/response-builder';
import { requireAuth } from '../middleware/auth';

const CreateBrokeredListingSchema = z.object({
  token_id: z.string(),
  price_wei: z.string(),
  currency_address: z.string().default('0x0000000000000000000000000000000000000000'),
  order_data: z.string(), // JSON string containing Seaport order
  order_hash: z.string(),
  seller_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid seller address'),
  broker_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid broker address'),
  broker_fee_bps: z.number().int().min(0).max(10000),
  expires_at: z.string().optional(),
});

const GetByBrokerQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: z.enum(['active', 'sold', 'cancelled', 'expired', 'unfunded']).optional(),
});

export async function brokeredListingsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // GET /api/v1/brokered-listings/config - Get broker fee configuration
  fastify.get('/config', async (_request, reply) => {
    const brokerConfig = getBrokerFeeConfig();
    return reply.send({
      success: true,
      data: {
        minFeeBasisPoints: brokerConfig.minBasisPoints,
        minFeePercent: brokerConfig.minBasisPoints / 100,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /api/v1/brokered-listings - Create a brokered listing
  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    // Validate request body with Zod
    const parseResult = CreateBrokeredListingSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parseResult.error.errors.map(e => e.message).join(', '),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    const body = parseResult.data;

    // Verify seller address matches authenticated user
    if (body.seller_address.toLowerCase() !== request.user!.address.toLowerCase()) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Seller address does not match authenticated user',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const brokerConfig = getBrokerFeeConfig();

    // Validate seller !== broker (no self-brokering)
    if (body.seller_address.toLowerCase() === body.broker_address.toLowerCase()) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'SELF_BROKER_NOT_ALLOWED',
          message: 'Seller cannot be their own broker',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // Validate minimum broker fee
    if (body.broker_fee_bps < brokerConfig.minBasisPoints) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'BROKER_FEE_TOO_LOW',
          message: `Broker fee must be at least ${brokerConfig.minBasisPoints} basis points (${brokerConfig.minBasisPoints / 100}%)`,
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      // Validate all fees in order (platform if enabled + broker always)
      const feeValidation = validateBrokeredListingFees(
        body.order_data,
        body.broker_address,
        body.broker_fee_bps
      );

      if (!feeValidation.valid) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_FEE',
            message: feeValidation.error || 'Invalid fee configuration in order',
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // Look up the ENS name by token_id - it must already exist in the database
      const ensQuery = `SELECT id, name FROM ens_names WHERE token_id = $1 LIMIT 1`;
      const ensResult = await pool.query(ensQuery, [body.token_id]);

      if (ensResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAME_NOT_FOUND',
            message: `ENS name with token_id "${body.token_id}" not found`,
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const ensNameId = ensResult.rows[0].id;

      // Parse order data to get expiry time
      const orderData = JSON.parse(body.order_data);
      const expiresAt = body.expires_at
        ? new Date(body.expires_at)
        : orderData.parameters?.endTime
          ? new Date(Number(orderData.parameters.endTime) * 1000)
          : null;

      // Cancel any existing active listings with same order_hash and source
      const cancelledResult = await pool.query(`
        UPDATE listings
        SET status = 'cancelled', updated_at = NOW()
        WHERE order_hash = $1
        AND source = 'grails'
        AND status = 'active'
        RETURNING id
      `, [body.order_hash]);

      if (cancelledResult.rows.length > 0) {
        fastify.log.info(`Auto-cancelled ${cancelledResult.rows.length} existing listing(s) with order_hash ${body.order_hash}`);
      }

      // Insert the brokered listing (or update if order_hash/source already exists)
      const insertQuery = `
        INSERT INTO listings (
          ens_name_id,
          seller_address,
          price_wei,
          currency_address,
          order_hash,
          order_data,
          status,
          source,
          expires_at,
          broker_address,
          broker_fee_bps,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 'grails', $7, $8, $9, NOW(), NOW())
        ON CONFLICT (order_hash, source) DO UPDATE SET
          ens_name_id = EXCLUDED.ens_name_id,
          seller_address = EXCLUDED.seller_address,
          price_wei = EXCLUDED.price_wei,
          currency_address = EXCLUDED.currency_address,
          order_data = EXCLUDED.order_data,
          status = 'active',
          expires_at = EXCLUDED.expires_at,
          broker_address = EXCLUDED.broker_address,
          broker_fee_bps = EXCLUDED.broker_fee_bps,
          updated_at = NOW()
        RETURNING *
      `;

      const result = await pool.query(insertQuery, [
        ensNameId,
        body.seller_address.toLowerCase(),
        body.price_wei,
        body.currency_address.toLowerCase(),
        body.order_hash,
        body.order_data,
        expiresAt,
        body.broker_address.toLowerCase(),
        body.broker_fee_bps,
      ]);

      const listing = result.rows[0];

      // Use ENS name data from the initial query
      const responseData = {
        ...listing,
        ens_name: ensResult.rows[0].name,
        token_id: body.token_id,
      };

      return reply.status(201).send({
        success: true,
        data: responseData,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });

    } catch (error: any) {
      fastify.log.error('Error creating brokered listing:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'BROKERED_LISTING_FAILED',
          message: error.message || 'Failed to create brokered listing',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  // GET /api/v1/brokered-listings/broker/:address - Get listings by broker address
  // Returns results in the standard search format with full ENS name data
  fastify.get('/broker/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const query = GetByBrokerQuerySchema.parse(request.query);

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INVALID_ADDRESS',
          message: 'Invalid Ethereum address format',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const offset = (query.page - 1) * query.limit;

    const whereConditions = ['l.broker_address = $1'];
    const params: any[] = [address.toLowerCase()];
    let paramCount = 2;

    if (query.status) {
      whereConditions.push(`l.status = $${paramCount}`);
      params.push(query.status);
      paramCount++;
    }

    // Get count for pagination
    const countQuery = `
      SELECT COUNT(DISTINCT en.name) FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      WHERE ${whereConditions.join(' AND ')}
    `;

    // Get ENS names for brokered listings (for use with buildSearchResults)
    const namesQuery = `
      SELECT DISTINCT en.name
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY en.name
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;

    params.push(query.limit, offset);

    const [countResult, namesResult] = await Promise.all([
      pool.query(countQuery, params.slice(0, paramCount - 1)),
      pool.query(namesQuery, params),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const ensNames = namesResult.rows.map((row: { name: string }) => row.name);

    // Use buildSearchResults for consistent response format
    const results = ensNames.length > 0 ? await buildSearchResults(ensNames) : [];

    return reply.send({
      success: true,
      data: {
        results,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // GET /api/v1/brokered-listings/stats - Get broker statistics (optional endpoint)
  fastify.get('/stats', async (_request, reply) => {
    const statsQuery = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        COUNT(*) FILTER (WHERE status = 'sold') as sold_count,
        COUNT(DISTINCT broker_address) as unique_brokers,
        AVG(broker_fee_bps) as avg_broker_fee_bps
      FROM listings
      WHERE broker_address IS NOT NULL
    `;

    const result = await pool.query(statsQuery);
    const stats = result.rows[0];

    return reply.send({
      success: true,
      data: {
        activeBrokeredListings: parseInt(stats.active_count) || 0,
        soldBrokeredListings: parseInt(stats.sold_count) || 0,
        uniqueBrokers: parseInt(stats.unique_brokers) || 0,
        averageBrokerFeeBps: stats.avg_broker_fee_bps ? parseFloat(stats.avg_broker_fee_bps) : null,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });
}
