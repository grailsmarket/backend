import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';

const HASH32 = /^0x[0-9a-fA-F]{64}$/; // tx hash / order hash
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// The Grails app reports a fill right after broadcasting the fulfillment tx. A single tx can fill
// multiple orders (cart checkout), so `orders` is a list.
const FillReportSchema = z.object({
  transactionHash: z.string().regex(HASH32),
  fillerAddress: z.string().regex(ADDRESS), // connected wallet that executed the fill
  orders: z.array(z.object({ orderHash: z.string().regex(HASH32) })).min(1).max(500),
});

export async function fillsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // POST /api/v1/fills - Record that orders were filled through the Grails app.
  // The fill itself happens on-chain (wallet -> Seaport); this only records attribution. The
  // indexer independently verifies the trade and that the reported filler is the real on-chain
  // buyer/seller before stamping sales.filled_via, so a report can only tag a genuine sale.
  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const body = FillReportSchema.parse(request.body);

    const filler = body.fillerAddress.toLowerCase();
    const userAddress = request.user!.address.toLowerCase();
    if (filler !== userAddress) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'fillerAddress does not match authenticated user',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const txHash = body.transactionHash.toLowerCase();
    const orderHashes = [...new Set(body.orders.map((o) => o.orderHash.toLowerCase()))];

    let recorded = 0;
    let reconciled = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const orderHash of orderHashes) {
        // 1. Persist the fill report (idempotent per tx+order).
        const ins = await client.query(
          `INSERT INTO order_fills (order_hash, transaction_hash, filler_address, source)
           VALUES ($1, $2, $3, 'grails')
           ON CONFLICT (transaction_hash, order_hash) DO NOTHING`,
          [orderHash, txHash, filler]
        );
        if (ins.rowCount && ins.rowCount > 0) recorded++;

        // 2. Reconcile the sale-first race: if the indexer already recorded this sale before the
        //    app's report arrived, back-fill filled_via now. Same anti-spoof guard as the indexer:
        //    only tag sales where the reporter is the on-chain buyer or seller.
        const sales = await client.query(
          `SELECT id FROM sales
           WHERE filled_via IS NULL
             AND (order_hash = $1 OR transaction_hash = $2)
             AND (lower(buyer_address) = $3 OR lower(seller_address) = $3)`,
          [orderHash, txHash, filler]
        );

        for (const row of sales.rows) {
          await client.query(`UPDATE sales SET filled_via = 'grails' WHERE id = $1`, [row.id]);
          await client.query(
            `UPDATE activity_history
             SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{filled_via}', '"grails"')
             WHERE (metadata->>'sale_id')::integer = $1`,
            [row.id]
          );
          reconciled++;
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to record fill',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    } finally {
      client.release();
    }

    const response: APIResponse = {
      success: true,
      data: { recorded, reconciled },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}
