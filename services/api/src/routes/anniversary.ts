import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getAddress } from 'viem';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { createCacheHandler } from '../middleware/cache';
import { generateCacheKey } from '../utils/redis';
import type { AnniversaryNftType, AnniversaryProofResponse } from '../services/anniversary-nft';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const AddressParams = z.object({ address: z.string().regex(ADDRESS_RE) });

/** Case-insensitive, so 0xAbC… and 0xabc… share one cache entry. */
export const anniversaryProofCacheKey = (address: string) =>
  generateCacheKey(`/api/v1/anniversary/proof/${address.toLowerCase()}`);

// Proofs only change when scripts/import-anniversary-proofs.ts re-imports the list.
const proofCacheHandler = createCacheHandler({
  ttl: 60,
  keyGenerator: (request) => anniversaryProofCacheKey(String((request.params as { address?: string }).address ?? '')),
});

const ok = <T>(data: T): APIResponse<T> => ({
  success: true,
  data,
  meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
});

const sendError = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.status(status).send({
    success: false,
    error: { code, message },
    meta: { timestamp: new Date().toISOString() },
  });

/**
 * Grails anniversary NFT claim proofs. Mounted at /api/v1/anniversary.
 */
export async function anniversaryRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/anniversary/proof/:address
   * Public. The token id, type and merkle proof for claim(account, tokenId, proof), or
   * eligible: false (still 200) when the address isn't on the list.
   */
  fastify.get('/proof/:address', { preHandler: proofCacheHandler }, async (request, reply) => {
    const params = AddressParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, 'INVALID_ADDRESS', 'Invalid Ethereum address format');
    }
    const address = params.data.address.toLowerCase();

    try {
      const result = await pool.query<{ token_id: number; nft_type: AnniversaryNftType; proof: string[]; merkle_root: string }>(
        `SELECT token_id, nft_type, proof, merkle_root
           FROM anniversary_nft_claims
          WHERE address = $1`,
        [address]
      );

      const row = result.rows[0];
      const data: AnniversaryProofResponse = row
        ? {
            address: getAddress(address),
            eligible: true,
            tokenId: row.token_id,
            type: row.nft_type,
            proof: row.proof,
            merkleRoot: row.merkle_root,
          }
        : { address: getAddress(address), eligible: false };

      return reply.send(ok(data));
    } catch (error) {
      fastify.log.error({ error }, 'Failed to fetch anniversary NFT proof');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch anniversary NFT proof');
    }
  });
}
