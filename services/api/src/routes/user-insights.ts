import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { buildSearchResults } from '../utils/response-builder';
import { requireAuth } from '../middleware/auth';

const PaginationQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export async function userInsightsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /user/history/viewed
   * Get user's recently viewed names
   */
  fastify.get('/history/viewed', { preHandler: requireAuth }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);
    const offset = (query.page - 1) * query.limit;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        'SELECT COUNT(*) FROM name_views WHERE viewer_identifier = $1 AND viewer_type = $2',
        [userId.toString(), 'authenticated']
      ),

      pool.query(
        `SELECT
          nv.ens_name_id,
          en.name,
          nv.viewed_at
        FROM name_views nv
        JOIN ens_names en ON nv.ens_name_id = en.id
        WHERE nv.viewer_identifier = $1 AND nv.viewer_type = $2
        ORDER BY nv.viewed_at DESC
        LIMIT $3 OFFSET $4`,
        [userId.toString(), 'authenticated', query.limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / query.limit);

    // Enrich with full name data
    const names = dataResult.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add viewed_at timestamp to enriched results
    const resultsWithTimestamp = enrichedResults.map(name => {
      const historyEntry = dataResult.rows.find(r => r.name === name.name);
      return {
        ...name,
        viewed_at: historyEntry?.viewed_at,
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithTimestamp,
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
  });

  /**
   * GET /user/history/watched
   * Get user's watchlist history (same as watchlist but with timestamps)
   */
  fastify.get('/history/watched', { preHandler: requireAuth }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);
    const offset = (query.page - 1) * query.limit;

    const [countResult, dataResult] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM watchlist WHERE user_id = $1', [userId]),

      pool.query(
        `SELECT
          w.ens_name_id,
          en.name,
          w.added_at,
          w.notify_on_sale,
          w.notify_on_offer,
          w.notify_on_listing,
          w.notify_on_price_change
        FROM watchlist w
        JOIN ens_names en ON w.ens_name_id = en.id
        WHERE w.user_id = $1
        ORDER BY w.added_at DESC
        LIMIT $2 OFFSET $3`,
        [userId, query.limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / query.limit);

    // Enrich with full name data
    const names = dataResult.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add watchlist metadata to enriched results
    const resultsWithMetadata = enrichedResults.map(name => {
      const watchEntry = dataResult.rows.find(r => r.name === name.name);
      return {
        ...name,
        added_at: watchEntry?.added_at,
        notifications: {
          on_sale: watchEntry?.notify_on_sale || false,
          on_offer: watchEntry?.notify_on_offer || false,
          on_listing: watchEntry?.notify_on_listing || false,
          on_price_change: watchEntry?.notify_on_price_change || false,
        },
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetadata,
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
  });

  /**
   * GET /user/history/voted
   * Get names the user has voted on
   */
  fastify.get('/history/voted', { preHandler: requireAuth }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);
    const offset = (query.page - 1) * query.limit;

    const [countResult, dataResult] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM name_votes WHERE user_id = $1', [userId]),

      pool.query(
        `SELECT
          nv.ens_name_id,
          en.name,
          nv.vote,
          nv.created_at
        FROM name_votes nv
        JOIN ens_names en ON nv.ens_name_id = en.id
        WHERE nv.user_id = $1
        ORDER BY nv.created_at DESC
        LIMIT $2 OFFSET $3`,
        [userId, query.limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / query.limit);

    // Enrich with full name data
    const names = dataResult.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add vote metadata to enriched results
    const resultsWithVotes = enrichedResults.map(name => {
      const voteEntry = dataResult.rows.find(r => r.name === name.name);
      return {
        ...name,
        my_vote: voteEntry?.vote,
        voted_at: voteEntry?.created_at,
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithVotes,
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
  });

  /**
   * GET /user/history/offers
   * Get offers the user has made
   */
  fastify.get('/history/offers', { preHandler: requireAuth }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);
    const offset = (query.page - 1) * query.limit;

    // Get user's wallet address
    const userResult = await pool.query(
      'SELECT wallet_address FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const walletAddress = userResult.rows[0].wallet_address;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        'SELECT COUNT(*) FROM offers WHERE LOWER(buyer_address) = LOWER($1)',
        [walletAddress]
      ),

      pool.query(
        `SELECT
          o.id,
          o.ens_name_id,
          en.name,
          o.offer_amount_wei,
          o.currency_address,
          o.status,
          o.created_at,
          o.expires_at
        FROM offers o
        JOIN ens_names en ON o.ens_name_id = en.id
        WHERE LOWER(o.buyer_address) = LOWER($1)
        ORDER BY o.created_at DESC
        LIMIT $2 OFFSET $3`,
        [walletAddress, query.limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / query.limit);

    // Enrich with full name data
    const names = dataResult.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add offer metadata to enriched results
    const resultsWithOffers = enrichedResults.map(name => {
      const offerEntry = dataResult.rows.find(r => r.name === name.name);
      return {
        ...name,
        offer: {
          id: offerEntry?.id,
          price_wei: offerEntry?.offer_amount_wei,
          currency_address: offerEntry?.currency_address,
          status: offerEntry?.status,
          created_at: offerEntry?.created_at,
          expires_at: offerEntry?.expires_at,
        },
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithOffers,
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
  });

  /**
   * GET /user/history/purchases
   * Get names the user has purchased
   */
  fastify.get('/history/purchases', { preHandler: requireAuth }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);
    const offset = (query.page - 1) * query.limit;

    // Get user's wallet address
    const userResult = await pool.query(
      'SELECT wallet_address FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const walletAddress = userResult.rows[0].wallet_address;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        'SELECT COUNT(*) FROM sales WHERE LOWER(buyer_address) = LOWER($1)',
        [walletAddress]
      ),

      pool.query(
        `SELECT
          s.id,
          s.ens_name_id,
          en.name,
          s.price_wei,
          s.currency_address,
          s.sale_date,
          s.transaction_hash
        FROM sales s
        JOIN ens_names en ON s.ens_name_id = en.id
        WHERE LOWER(s.buyer_address) = LOWER($1)
        ORDER BY s.sale_date DESC
        LIMIT $2 OFFSET $3`,
        [walletAddress, query.limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / query.limit);

    // Enrich with full name data
    const names = dataResult.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add sale metadata to enriched results
    const resultsWithSales = enrichedResults.map(name => {
      const saleEntry = dataResult.rows.find(r => r.name === name.name);
      return {
        ...name,
        purchase: {
          id: saleEntry?.id,
          price_wei: saleEntry?.price_wei,
          currency_address: saleEntry?.currency_address,
          sale_date: saleEntry?.sale_date,
          transaction_hash: saleEntry?.transaction_hash,
        },
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithSales,
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
  });

  /**
   * GET /user/history/sales
   * Get names the user has sold
   */
  fastify.get('/history/sales', { preHandler: requireAuth }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);
    const offset = (query.page - 1) * query.limit;

    // Get user's wallet address
    const userResult = await pool.query(
      'SELECT wallet_address FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const walletAddress = userResult.rows[0].wallet_address;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        'SELECT COUNT(*) FROM sales WHERE LOWER(seller_address) = LOWER($1)',
        [walletAddress]
      ),

      pool.query(
        `SELECT
          s.id,
          s.ens_name_id,
          en.name,
          s.price_wei,
          s.currency_address,
          s.sale_date,
          s.transaction_hash,
          s.buyer_address
        FROM sales s
        JOIN ens_names en ON s.ens_name_id = en.id
        WHERE LOWER(s.seller_address) = LOWER($1)
        ORDER BY s.sale_date DESC
        LIMIT $2 OFFSET $3`,
        [walletAddress, query.limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / query.limit);

    // Enrich with full name data
    const names = dataResult.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add sale metadata to enriched results
    const resultsWithSales = enrichedResults.map(name => {
      const saleEntry = dataResult.rows.find(r => r.name === name.name);
      return {
        ...name,
        sale: {
          id: saleEntry?.id,
          price_wei: saleEntry?.price_wei,
          currency_address: saleEntry?.currency_address,
          sale_date: saleEntry?.sale_date,
          transaction_hash: saleEntry?.transaction_hash,
          buyer_address: saleEntry?.buyer_address,
        },
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithSales,
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
  });
}
