import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { buildSearchResults } from '../utils/response-builder';

const AddToCartSchema = z.object({
  ensNameId: z.number().int().positive(),
  cartType: z.string().min(1),
});

const BulkAddToCartSchema = z.object({
  items: z.array(z.object({
    ensNameId: z.number().int().positive(),
    cartType: z.string().min(1),
  })).min(1).max(100), // Limit bulk adds to 100 items
});

const ClearCartSchema = z.object({
  cartType: z.string().optional(),
});

const GetCartQuerySchema = z.object({
  type: z.string().optional(),
});

export async function cartRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/cart
   * Get user's cart items, optionally filtered by cart type
   */
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { type } = GetCartQuerySchema.parse(request.query);
      const userId = parseInt(request.user.sub);

      // Build query based on whether type filter is provided
      let query = `
        SELECT
          ci.id,
          ci.ens_name_id,
          ci.cart_type_id,
          ci.created_at,
          en.name,
          ct.name as cart_type_name
        FROM cart_items ci
        JOIN ens_names en ON ci.ens_name_id = en.id
        JOIN cart_types ct ON ci.cart_type_id = ct.id
        WHERE ci.user_id = $1
      `;

      const params: any[] = [userId];

      if (type) {
        query += ' AND ct.name = $2';
        params.push(type);
      }

      query += ' ORDER BY ci.created_at DESC';

      const cartResult = await pool.query(query, params);

      if (cartResult.rows.length === 0) {
        return reply.send({
          success: true,
          data: {
            items: [],
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        });
      }

      // Extract ENS names for buildSearchResults
      const ensNames = cartResult.rows.map(row => row.name);

      // Use buildSearchResults to get enriched ENS data
      const enrichedNames = await buildSearchResults(ensNames, userId);

      // Create a map of name -> enriched data
      const nameMap = new Map(enrichedNames.map(n => [n.name.toLowerCase(), n]));

      // Merge cart metadata with enriched ENS data
      const items = cartResult.rows.map(row => {
        const enrichedData = nameMap.get(row.name.toLowerCase());
        return {
          cartItemId: row.id,
          cartType: row.cart_type_name,
          addedAt: row.created_at,
          ...enrichedData, // Spread all enriched ENS data
        };
      });

      const response: APIResponse = {
        success: true,
        data: {
          items,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching cart:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch cart',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/cart/summary
   * Get cart item counts by type
   */
  fastify.get('/summary', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const userId = parseInt(request.user.sub);

      const summaryResult = await pool.query(
        `SELECT
          ct.name as cart_type,
          COUNT(ci.id) as count
        FROM cart_types ct
        LEFT JOIN cart_items ci ON ci.cart_type_id = ct.id AND ci.user_id = $1
        GROUP BY ct.id, ct.name
        ORDER BY ct.name`,
        [userId]
      );

      const summary = summaryResult.rows.reduce((acc, row) => {
        acc[row.cart_type] = parseInt(row.count);
        return acc;
      }, {} as Record<string, number>);

      const response: APIResponse = {
        success: true,
        data: {
          summary,
          total: (Object.values(summary) as number[]).reduce((sum, count) => sum + count, 0),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching cart summary:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch cart summary',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * POST /api/v1/cart
   * Add a single ENS name to cart
   */
  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const data = AddToCartSchema.parse(request.body);
      const userId = parseInt(request.user.sub);

      // Verify cart type exists
      const cartTypeResult = await pool.query(
        'SELECT id FROM cart_types WHERE name = $1',
        [data.cartType]
      );

      if (cartTypeResult.rows.length === 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_CART_TYPE',
            message: `Cart type "${data.cartType}" does not exist`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const cartTypeId = cartTypeResult.rows[0].id;

      // Verify ENS name exists
      const ensResult = await pool.query(
        'SELECT id, name FROM ens_names WHERE id = $1',
        [data.ensNameId]
      );

      if (ensResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAME_NOT_FOUND',
            message: `ENS name with ID ${data.ensNameId} not found`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const ensName = ensResult.rows[0].name;

      // Insert or return existing cart item
      const cartItemResult = await pool.query(
        `INSERT INTO cart_items (user_id, ens_name_id, cart_type_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, ens_name_id, cart_type_id) DO NOTHING
        RETURNING *`,
        [userId, data.ensNameId, cartTypeId]
      );

      // Check if item was already in cart
      const isNew = cartItemResult.rows.length > 0;

      const response: APIResponse = {
        success: true,
        data: {
          message: isNew ? 'Added to cart' : 'Item already in cart',
          cartItemId: isNew ? cartItemResult.rows[0].id : null,
          ensNameId: data.ensNameId,
          ensName: ensName,
          cartType: data.cartType,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error adding to cart:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to add to cart',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * POST /api/v1/cart/bulk
   * Add multiple ENS names to cart
   */
  fastify.post('/bulk', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const data = BulkAddToCartSchema.parse(request.body);
      const userId = parseInt(request.user.sub);

      // Get all cart types
      const cartTypesResult = await pool.query('SELECT id, name FROM cart_types');
      const cartTypeMap = new Map(cartTypesResult.rows.map(row => [row.name, row.id]));

      // Validate all cart types exist
      const invalidTypes = data.items
        .map(item => item.cartType)
        .filter(type => !cartTypeMap.has(type));

      if (invalidTypes.length > 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_CART_TYPES',
            message: `Invalid cart types: ${invalidTypes.join(', ')}`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Verify all ENS name IDs exist
      const ensNameIds = data.items.map(item => item.ensNameId);
      const ensResult = await pool.query(
        'SELECT id FROM ens_names WHERE id = ANY($1::int[])',
        [ensNameIds]
      );

      const foundIds = new Set(ensResult.rows.map(row => row.id));

      // Track which IDs were not found
      const notFoundIds = ensNameIds.filter(id => !foundIds.has(id));

      if (notFoundIds.length > 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAMES_NOT_FOUND',
            message: `ENS name IDs not found: ${notFoundIds.join(', ')}`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Bulk insert cart items
      const values = data.items
        .map((item, i) => {
          const cartTypeId = cartTypeMap.get(item.cartType);
          return `($1, $${i * 2 + 2}, $${i * 2 + 3})`;
        })
        .join(', ');

      const params: any[] = [userId];
      data.items.forEach(item => {
        params.push(item.ensNameId);
        params.push(cartTypeMap.get(item.cartType));
      });

      const bulkResult = await pool.query(
        `INSERT INTO cart_items (user_id, ens_name_id, cart_type_id)
        VALUES ${values}
        ON CONFLICT (user_id, ens_name_id, cart_type_id) DO NOTHING
        RETURNING *`,
        params
      );

      const response: APIResponse = {
        success: true,
        data: {
          message: `Added ${bulkResult.rows.length} items to cart`,
          addedCount: bulkResult.rows.length,
          totalRequested: data.items.length,
          skippedCount: data.items.length - bulkResult.rows.length,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error bulk adding to cart:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to bulk add to cart',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * DELETE /api/v1/cart/:id
   * Remove a single item from cart by cart_item_id
   */
  fastify.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { id } = request.params as { id: string };
      const userId = parseInt(request.user.sub);

      // Verify cart item belongs to user
      const checkResult = await pool.query(
        'SELECT user_id FROM cart_items WHERE id = $1',
        [parseInt(id)]
      );

      if (checkResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Cart item not found',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      if (checkResult.rows[0].user_id !== userId) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'This cart item belongs to another user',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Delete item
      await pool.query('DELETE FROM cart_items WHERE id = $1', [parseInt(id)]);

      const response: APIResponse = {
        success: true,
        data: {
          message: 'Removed from cart',
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error removing from cart:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to remove from cart',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * DELETE /api/v1/cart
   * Clear cart (all items or by cart type)
   */
  fastify.delete('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { cartType } = ClearCartSchema.parse(request.body);
      const userId = parseInt(request.user.sub);

      let query = 'DELETE FROM cart_items WHERE user_id = $1';
      const params: any[] = [userId];

      if (cartType) {
        // Verify cart type exists
        const cartTypeResult = await pool.query(
          'SELECT id FROM cart_types WHERE name = $1',
          [cartType]
        );

        if (cartTypeResult.rows.length === 0) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'INVALID_CART_TYPE',
              message: `Cart type "${cartType}" does not exist`,
            },
            meta: {
              timestamp: new Date().toISOString(),
            },
          });
        }

        query += ' AND cart_type_id = $2';
        params.push(cartTypeResult.rows[0].id);
      }

      const result = await pool.query(query, params);
      const deletedCount = result.rowCount || 0;

      const response: APIResponse = {
        success: true,
        data: {
          message: cartType ? `Cleared ${cartType} cart` : 'Cleared all cart items',
          deletedCount,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error clearing cart:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to clear cart',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
