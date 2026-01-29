import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, SeaportOrder, validateFeeInOrder } from '../../../shared/src';
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
  private_buyer_address: z.string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address')
    .optional()
    .nullable(),
});

// Schema for bulk listing creation
const BulkSaveOrderSchema = z.object({
  listings: z.array(z.object({
    type: z.literal('listing'),
    token_id: z.string(),
    price_wei: z.string(),
    currency_address: z.string().default('0x0000000000000000000000000000000000000000'),
    order_data: z.string(), // JSON string of Seaport order
    order_hash: z.string(),
    seller_address: z.string(),
    traits: z.any().optional(),
    status: z.string().default('active'),
    source: z.string().default('grails'),
    private_buyer_address: z.string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional()
      .nullable(),
  })).min(1).max(500),
});

// Types for bulk response
interface BulkListingResult {
  index: number;
  token_id: string;
  order_hash: string;
  status: 'created' | 'failed' | 'skipped';
  listing_id?: number;
  error?: {
    code: string;
    message: string;
  };
}

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

        // Validate fee for Grails marketplace orders
        const feeValidation = validateFeeInOrder(body.order_data, body.source);
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

        // Validate: private listings only allowed for Grails source
        if (body.private_buyer_address && body.source !== 'grails') {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'PRIVATE_LISTING_GRAILS_ONLY',
              message: 'Private listings are only supported for Grails marketplace',
            },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        // Validate: private buyer cannot be the seller
        if (body.private_buyer_address &&
            body.private_buyer_address.toLowerCase() === body.seller_address?.toLowerCase()) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'SELF_PRIVATE_NOT_ALLOWED',
              message: 'Cannot create private listing for yourself',
            },
            meta: { timestamp: new Date().toISOString() },
          });
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
            private_buyer_address,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
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
          body.private_buyer_address?.toLowerCase() || null,
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

  // POST /api/v1/orders/bulk - Bulk create listings (up to 500)
  fastify.post('/bulk', async (request, reply) => {
    // Parse and validate request body
    const parseResult = BulkSaveOrderSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parseResult.error.errors,
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const { listings } = parseResult.data;
    const results: BulkListingResult[] = [];
    const validListings: Array<typeof listings[0] & { index: number; ensNameId?: number; expiresAt?: Date | null }> = [];

    try {
      // Step 1: Validate fees upfront for all grails source listings
      for (let i = 0; i < listings.length; i++) {
        const listing = listings[i];
        const feeValidation = validateFeeInOrder(listing.order_data, listing.source);

        if (!feeValidation.valid) {
          results.push({
            index: i,
            token_id: listing.token_id,
            order_hash: listing.order_hash,
            status: 'failed',
            error: {
              code: 'INVALID_FEE',
              message: feeValidation.error || 'Invalid marketplace fee',
            },
          });
        } else if (listing.private_buyer_address && listing.source !== 'grails') {
          // Private listings only allowed for Grails source
          results.push({
            index: i,
            token_id: listing.token_id,
            order_hash: listing.order_hash,
            status: 'failed',
            error: {
              code: 'PRIVATE_LISTING_GRAILS_ONLY',
              message: 'Private listings are only supported for Grails marketplace',
            },
          });
        } else if (listing.private_buyer_address &&
                   listing.private_buyer_address.toLowerCase() === listing.seller_address.toLowerCase()) {
          // Private buyer cannot be the seller
          results.push({
            index: i,
            token_id: listing.token_id,
            order_hash: listing.order_hash,
            status: 'failed',
            error: {
              code: 'SELF_PRIVATE_NOT_ALLOWED',
              message: 'Cannot create private listing for yourself',
            },
          });
        } else {
          // Parse expiry time from order data
          let expiresAt: Date | null = null;
          try {
            const orderData = JSON.parse(listing.order_data);
            if (orderData.parameters?.endTime) {
              expiresAt = new Date(Number(orderData.parameters.endTime) * 1000);
            }
          } catch {
            // Ignore JSON parse errors, expiresAt will be null
          }

          validListings.push({ ...listing, index: i, expiresAt });
        }
      }

      if (validListings.length === 0) {
        // All listings failed fee validation
        return reply.status(207).send({
          success: false,
          data: {
            summary: {
              total: listings.length,
              succeeded: 0,
              failed: results.length,
              skipped: 0,
            },
            results,
          },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        });
      }

      // Step 2: Batch query existing ENS names
      const tokenIds = validListings.map(l => l.token_id);
      const existingEnsQuery = `
        SELECT id, token_id, name FROM ens_names
        WHERE token_id = ANY($1::text[])
      `;
      const existingEnsResult = await pool.query(existingEnsQuery, [tokenIds]);
      const existingEnsMap = new Map<string, { id: number; name: string }>(
        existingEnsResult.rows.map(row => [row.token_id, { id: row.id, name: row.name }])
      );

      // Step 3: Identify missing ENS names and fetch from The Graph
      const missingTokenIds = tokenIds.filter(id => !existingEnsMap.has(id));

      if (missingTokenIds.length > 0) {
        // Batch fetch from The Graph in chunks of 100
        const ensNamesToCreate: Array<{ token_id: string; name: string; owner_address: string }> = [];

        for (let i = 0; i < missingTokenIds.length; i += 100) {
          const chunk = missingTokenIds.slice(i, i + 100);
          const graphIds = chunk.map(id => '0x' + BigInt(id).toString(16).padStart(64, '0'));

          try {
            const subgraphResponse = await fetch('https://api.thegraph.com/subgraphs/name/ensdomains/ens', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: `
                  query GetDomains($ids: [String!]!) {
                    domains(where: { id_in: $ids }) {
                      id
                      name
                      labelhash
                    }
                  }
                `,
                variables: { ids: graphIds },
              }),
            });

            if (subgraphResponse.ok) {
              const subgraphData: any = await subgraphResponse.json();
              const domains = subgraphData.data?.domains || [];

              // Create a map of graph ID to name
              const graphNameMap = new Map<string, string>(
                domains.map((d: any) => [d.id.toLowerCase(), d.name])
              );

              // Match back to token IDs
              for (const tokenId of chunk) {
                const graphId = ('0x' + BigInt(tokenId).toString(16).padStart(64, '0')).toLowerCase();
                const name = graphNameMap.get(graphId) || `token-${tokenId}.eth`;
                const listing = validListings.find(l => l.token_id === tokenId);

                ensNamesToCreate.push({
                  token_id: tokenId,
                  name,
                  owner_address: listing?.seller_address || '0x0000000000000000000000000000000000000000',
                });
              }
            } else {
              // Fallback: create placeholder names
              for (const tokenId of chunk) {
                const listing = validListings.find(l => l.token_id === tokenId);
                ensNamesToCreate.push({
                  token_id: tokenId,
                  name: `token-${tokenId}.eth`,
                  owner_address: listing?.seller_address || '0x0000000000000000000000000000000000000000',
                });
              }
            }
          } catch (error: any) {
            fastify.log.warn(`Failed to fetch ENS names from The Graph: ${error?.message || error}`);
            // Fallback: create placeholder names
            for (const tokenId of chunk) {
              const listing = validListings.find(l => l.token_id === tokenId);
              ensNamesToCreate.push({
                token_id: tokenId,
                name: `token-${tokenId}.eth`,
                owner_address: listing?.seller_address || '0x0000000000000000000000000000000000000000',
              });
            }
          }
        }

        // Batch insert new ENS names
        if (ensNamesToCreate.length > 0) {
          const insertEnsValues: any[] = [];
          const insertEnsPlaceholders: string[] = [];
          let paramIndex = 1;

          for (const ens of ensNamesToCreate) {
            insertEnsPlaceholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, NOW(), NOW())`);
            insertEnsValues.push(ens.token_id, ens.name, ens.owner_address);
            paramIndex += 3;
          }

          const insertEnsQuery = `
            INSERT INTO ens_names (token_id, name, owner_address, created_at, updated_at)
            VALUES ${insertEnsPlaceholders.join(', ')}
            ON CONFLICT (token_id) DO UPDATE SET updated_at = NOW()
            RETURNING id, token_id
          `;

          const insertEnsResult = await pool.query(insertEnsQuery, insertEnsValues);
          for (const row of insertEnsResult.rows) {
            existingEnsMap.set(row.token_id, { id: row.id, name: '' });
          }
        }
      }

      // Assign ENS name IDs to valid listings
      for (const listing of validListings) {
        const ensName = existingEnsMap.get(listing.token_id);
        if (ensName) {
          listing.ensNameId = ensName.id;
        } else {
          // This shouldn't happen, but handle it gracefully
          results.push({
            index: listing.index,
            token_id: listing.token_id,
            order_hash: listing.order_hash,
            status: 'failed',
            error: {
              code: 'ENS_NAME_NOT_FOUND',
              message: 'Failed to create or find ENS name record',
            },
          });
        }
      }

      // Filter out listings that failed ENS resolution
      const listingsWithEns = validListings.filter(l => l.ensNameId !== undefined);

      if (listingsWithEns.length === 0) {
        return reply.status(207).send({
          success: false,
          data: {
            summary: {
              total: listings.length,
              succeeded: 0,
              failed: results.length,
              skipped: 0,
            },
            results,
          },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        });
      }

      // Step 4: Delete existing duplicates (unique constraint prevents update+insert)
      // Build a VALUES clause for proper pairing of (order_hash, source)
      const deleteValues: any[] = [];
      const deletePlaceholders: string[] = [];
      let deleteParamIdx = 1;

      for (const listing of listingsWithEns) {
        deletePlaceholders.push(`($${deleteParamIdx}::text, $${deleteParamIdx + 1}::text)`);
        deleteValues.push(listing.order_hash, listing.source);
        deleteParamIdx += 2;
      }

      const deleteDuplicatesQuery = `
        DELETE FROM listings
        WHERE (order_hash, source) IN (VALUES ${deletePlaceholders.join(', ')})
        RETURNING id, order_hash, source
      `;

      const deletedResult = await pool.query(deleteDuplicatesQuery, deleteValues);

      if (deletedResult.rows.length > 0) {
        fastify.log.info(`Deleted ${deletedResult.rows.length} existing listing(s) with duplicate order_hash before re-creating`);
      }

      // Step 5: Batch insert listings
      const insertValues: any[] = [];
      const insertPlaceholders: string[] = [];
      let insertParamIndex = 1;
      const listingsToInsertIndexes: number[] = [];

      for (const listing of listingsWithEns) {
        insertPlaceholders.push(
          `($${insertParamIndex}, $${insertParamIndex + 1}, $${insertParamIndex + 2}, $${insertParamIndex + 3}, $${insertParamIndex + 4}, $${insertParamIndex + 5}, $${insertParamIndex + 6}, $${insertParamIndex + 7}, $${insertParamIndex + 8}, $${insertParamIndex + 9}, NOW(), NOW())`
        );
        insertValues.push(
          listing.ensNameId,
          listing.seller_address.toLowerCase(),
          listing.price_wei,
          listing.currency_address,
          listing.order_hash,
          listing.order_data,
          listing.status,
          listing.source,
          listing.expiresAt,
          listing.private_buyer_address?.toLowerCase() || null
        );
        listingsToInsertIndexes.push(listing.index);
        insertParamIndex += 10;
      }

      const insertListingsQuery = `
        INSERT INTO listings (
          ens_name_id, seller_address, price_wei, currency_address,
          order_hash, order_data, status, source, expires_at,
          private_buyer_address, created_at, updated_at
        )
        VALUES ${insertPlaceholders.join(', ')}
        RETURNING id, order_hash
      `;

      const insertResult = await pool.query(insertListingsQuery, insertValues);

      // Map inserted IDs back to results
      const insertedMap = new Map<string, number>(
        insertResult.rows.map(row => [row.order_hash, row.id])
      );

      // Build final results
      for (const listing of listingsWithEns) {
        const listingId = insertedMap.get(listing.order_hash);

        if (listingId) {
          // Successfully created (if there was an old listing, it was deleted first)
          results.push({
            index: listing.index,
            token_id: listing.token_id,
            order_hash: listing.order_hash,
            status: 'created',
            listing_id: listingId,
          });
        } else {
          results.push({
            index: listing.index,
            token_id: listing.token_id,
            order_hash: listing.order_hash,
            status: 'failed',
            error: {
              code: 'INSERT_FAILED',
              message: 'Failed to insert listing',
            },
          });
        }
      }

      // Sort results by index for consistent ordering
      results.sort((a, b) => a.index - b.index);

      // Calculate summary
      const succeeded = results.filter(r => r.status === 'created').length;
      const failed = results.filter(r => r.status === 'failed').length;
      const skipped = results.filter(r => r.status === 'skipped').length;

      // Determine status code
      const statusCode = failed === 0 ? 201 : 207;

      return reply.status(statusCode).send({
        success: failed === 0,
        data: {
          summary: {
            total: listings.length,
            succeeded,
            failed,
            skipped,
          },
          results,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    } catch (error: any) {
      fastify.log.error('Bulk listing creation failed:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'BULK_ORDER_FAILED',
          message: error.message || 'Failed to create bulk listings',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });
}