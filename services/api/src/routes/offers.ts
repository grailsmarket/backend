import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, Offer } from '../../../shared/src';

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
  status: z.enum(['pending', 'accepted', 'rejected', 'expired']).optional(),
});

export async function offersRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  fastify.post('/', async (request, reply) => {
    const body = CreateOfferSchema.parse(request.body);

    const query = `
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

      const response: APIResponse<Offer> = {
        success: true,
        data: result.rows[0],
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
  fastify.get('/by-name/:name', async (request, reply) => {
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
      SELECT * FROM offers
      WHERE ens_name_id = $1
      ${status ? 'AND status = $4' : ''}
      ORDER BY offer_amount_wei DESC, created_at DESC
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

    const query = `SELECT * FROM offers WHERE id = $1`;
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

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdateOfferSchema.parse(request.body);

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
      UPDATE offers
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
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

  // Get offers by buyer address
  fastify.get('/by-buyer/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const { page = 1, limit = 20, status } = request.query as any;
    const offset = (page - 1) * limit;

    const offersQuery = `
      SELECT o.*, e.name as ens_name, e.token_id
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
  fastify.get('/received/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const { page = 1, limit = 20, status } = request.query as any;
    const offset = (page - 1) * limit;

    const offersQuery = `
      SELECT o.*, e.name as ens_name, e.token_id
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
}