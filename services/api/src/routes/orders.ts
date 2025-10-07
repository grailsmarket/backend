import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, SeaportOrder } from '../../../shared/src';
import { createSeaportOrder, validateSeaportOrder } from '../services/seaport';

const CreateOrderSchema = z.object({
  tokenId: z.string(),
  price: z.string(),
  currency: z.string().default('0x0000000000000000000000000000000000000000'),
  duration: z.number().min(1).max(365).default(7), // days
  offerer: z.string(),
});

const ValidateOrderSchema = z.object({
  orderData: z.any(), // SeaportOrder type
});

const SaveOrderSchema = z.object({
  type: z.enum(['listing', 'offer', 'collection_offer']),
  token_id: z.string(),
  price_wei: z.string(),
  currency_address: z.string().default('0x0000000000000000000000000000000000000000'),
  order_data: z.string(), // JSON string
  order_hash: z.string(),
  seller_address: z.string().optional().nullable(),
  buyer_address: z.string().optional().nullable(),
  traits: z.any().optional(),
  status: z.string().default('active'),
  source: z.string().default('grails'),
});

export async function ordersRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // POST /api/v1/orders - Save order (listing/offer) to database
  fastify.post('/', async (request, reply) => {
    const body = SaveOrderSchema.parse(request.body);

    try {
      // For listings, first ensure ENS name exists or create it
      let ensNameId: number | null = null;

      if (body.type === 'listing') {
        // Try to find existing ENS name by token_id
        const ensQuery = `
          SELECT id, name FROM ens_names WHERE token_id = $1 LIMIT 1
        `;
        const ensResult = await pool.query(ensQuery, [body.token_id]);

        if (ensResult.rows.length > 0) {
          ensNameId = ensResult.rows[0].id;
        } else {
          // Fetch ENS name from blockchain
          let ensName = `token-${body.token_id}.eth`;

          try {
            // Use public Ethereum RPC to fetch the ENS name
            const response = await fetch('https://eth.llamarpc.com', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_call',
                params: [
                  {
                    to: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85', // ENS Base Registrar
                    data: '0xc87b56dd' + body.token_id.toString().padStart(64, '0'), // tokenURI(uint256)
                  },
                  'latest'
                ],
                id: 1,
              }),
            });

            if (response.ok) {
              const data = await response.json();
              // Try to parse the name from metadata
              // For now, we'll try a simpler approach: fetch from ENS subgraph
              const subgraphResponse = await fetch('https://api.thegraph.com/subgraphs/name/ensdomains/ens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query: `
                    query GetDomain($tokenId: String!) {
                      domain(id: $tokenId) {
                        name
                        labelhash
                      }
                    }
                  `,
                  variables: {
                    tokenId: '0x' + BigInt(body.token_id).toString(16).padStart(64, '0'),
                  },
                }),
              });

              if (subgraphResponse.ok) {
                const subgraphData: any = await subgraphResponse.json();
                if (subgraphData.data?.domain?.name) {
                  ensName = subgraphData.data.domain.name;
                }
              }
            }
          } catch (error: any) {
            fastify.log.warn(`Failed to fetch ENS name for token ${body.token_id}:`, error);
          }

          // Create ENS name record
          const insertEnsQuery = `
            INSERT INTO ens_names (token_id, name, owner_address, created_at, updated_at)
            VALUES ($1, $2, $3, NOW(), NOW())
            RETURNING id
          `;
          const insertResult = await pool.query(insertEnsQuery, [
            body.token_id,
            ensName,
            body.seller_address || '0x0000000000000000000000000000000000000000',
          ]);
          ensNameId = insertResult.rows[0].id;
        }

        // Parse order data to get expiry time
        const orderData = JSON.parse(body.order_data);
        const expiresAt = orderData.parameters?.endTime
          ? new Date(Number(orderData.parameters.endTime) * 1000)
          : null;

        // Check for existing active listing with same order_hash and source
        // If found, cancel it before creating the new one
        const checkExistingQuery = `
          UPDATE listings
          SET status = 'cancelled', updated_at = NOW()
          WHERE order_hash = $1
          AND source = $2
          AND status = 'active'
          RETURNING id
        `;

        const cancelledResult = await pool.query(checkExistingQuery, [
          body.order_hash,
          body.source,
        ]);

        if (cancelledResult.rows.length > 0) {
          fastify.log.info(`Auto-cancelled ${cancelledResult.rows.length} existing listing(s) with order_hash ${body.order_hash} and source ${body.source}`);
        }

        // Insert listing
        const insertListingQuery = `
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
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          RETURNING *
        `;

        const result = await pool.query(insertListingQuery, [
          ensNameId,
          body.seller_address,
          body.price_wei,
          body.currency_address,
          body.order_hash,
          body.order_data,
          body.status,
          body.source,
          expiresAt,
        ]);

        return reply.status(201).send({
          success: true,
          data: result.rows[0],
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        });
      } else {
        // Handle offers (not implemented yet)
        return reply.status(501).send({
          success: false,
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Offer creation not yet implemented',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }
    } catch (error: any) {
      fastify.log.error('Error saving order:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'ORDER_SAVE_FAILED',
          message: error.message || 'Failed to save order to database',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  fastify.post('/create', async (request, reply) => {
    const body = CreateOrderSchema.parse(request.body);

    try {
      const order = await createSeaportOrder({
        tokenId: body.tokenId,
        price: body.price,
        currency: body.currency,
        duration: body.duration,
        offerer: body.offerer,
      });

      const response: APIResponse<SeaportOrder> = {
        success: true,
        data: order,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'ORDER_CREATION_FAILED',
          message: error.message,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  fastify.post('/validate', async (request, reply) => {
    const body = ValidateOrderSchema.parse(request.body);

    try {
      const validation = await validateSeaportOrder(body.orderData);

      const response: APIResponse = {
        success: true,
        data: {
          valid: validation.valid,
          errors: validation.errors,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'ORDER_VALIDATION_FAILED',
          message: error.message,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const query = `
      SELECT * FROM listings
      WHERE order_hash = $1 OR id = $2
    `;

    const result = await pool.query(query, [id, parseInt(id) || 0]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'ORDER_NOT_FOUND',
          message: `Order "${id}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse = {
      success: true,
      data: result.rows[0],
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
      WHERE (order_hash = $1 OR id = $2)
      AND status = 'active'
      RETURNING *
    `;

    const result = await pool.query(query, [id, parseInt(id) || 0]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'ORDER_NOT_FOUND',
          message: `Active order "${id}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse = {
      success: true,
      data: {
        message: 'Order cancelled successfully',
        order: result.rows[0],
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}