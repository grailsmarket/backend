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
    const parsed = FillReportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    const body = parsed.data;

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

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Persist all fill reports in one statement (idempotent per tx+order). rowCount excludes
      //    rows that hit the unique conflict, giving the count actually newly recorded.
      const ins = await client.query(
        `INSERT INTO order_fills (order_hash, transaction_hash, filler_address, source)
         SELECT oh, $2, $3, 'grails' FROM unnest($1::text[]) AS oh
         ON CONFLICT (transaction_hash, order_hash) DO NOTHING`,
        [orderHashes, txHash, filler]
      );
      const recorded = ins.rowCount ?? 0;

      // 2. Reconcile the sale-first race in one set-based UPDATE: if the indexer already recorded
      //    these sales before the app's report arrived, back-fill filled_via now. Same anti-spoof
      //    guard as the indexer — only tag sales where the reporter is the on-chain buyer/seller.
      const reconcileResult = await client.query(
        `UPDATE sales SET filled_via = 'grails'
         WHERE filled_via IS NULL
           AND (order_hash = ANY($1::text[]) OR transaction_hash = $2)
           AND (lower(buyer_address) = $3 OR lower(seller_address) = $3)
         RETURNING id`,
        [orderHashes, txHash, filler]
      );
      const saleIds = reconcileResult.rows.map((r) => r.id);

      if (saleIds.length > 0) {
        await client.query(
          `UPDATE activity_history
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{filled_via}', '"grails"')
           WHERE (metadata->>'sale_id')::integer = ANY($1::int[])`,
          [saleIds]
        );
      }

      await client.query('COMMIT');

      const response: APIResponse = {
        success: true,
        data: { recorded, reconciled: saleIds.length },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
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
  });
}
