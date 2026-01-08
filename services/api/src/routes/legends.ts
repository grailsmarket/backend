import { FastifyInstance } from 'fastify';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { cacheHandler } from '../middleware/cache';

export async function legendsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // Get legend summary for an address
  fastify.get('/:address', { preHandler: cacheHandler }, async (request, reply) => {
    const { address } = request.params as { address: string };

    // Normalize address to lowercase
    const normalizedAddress = address.toLowerCase();

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid Ethereum address format',
      });
    }

    try {
      // Get summary stats grouped by legend type
      const query = `
        SELECT
          legend_type,
          COUNT(*) as count,
          MIN(block_time) as first_mint,
          MAX(block_time) as last_mint
        FROM legends
        WHERE minter_address = $1
        GROUP BY legend_type
      `;

      const result = await pool.query(query, [normalizedAddress]);

      // Build legends object from results
      const legends: Record<string, any> = {};

      for (const row of result.rows) {
        legends[row.legend_type] = {
          qualified: true,
          count: parseInt(row.count),
          firstMint: row.first_mint,
          lastMint: row.last_mint,
        };
      }

      const response: APIResponse = {
        success: true,
        data: {
          address: normalizedAddress,
          legends,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch legend summary',
      });
    }
  });

  // Get detailed legend mints for an address
  fastify.get('/:address/details', { preHandler: cacheHandler }, async (request, reply) => {
    const { address } = request.params as { address: string };
    const { type } = request.query as { type?: string };

    // Normalize address to lowercase
    const normalizedAddress = address.toLowerCase();

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid Ethereum address format',
      });
    }

    try {
      // Get all mints, optionally filtered by type
      let query = `
        SELECT
          legend_type,
          name,
          tx_hash,
          block_number,
          block_time,
          labelhash,
          namehash
        FROM legends
        WHERE minter_address = $1
      `;
      const params: any[] = [normalizedAddress];

      if (type) {
        query += ` AND legend_type = $2`;
        params.push(type);
      }

      query += ` ORDER BY block_time ASC`;

      const result = await pool.query(query, params);

      // Group mints by legend type
      const legends: Record<string, any> = {};

      for (const row of result.rows) {
        if (!legends[row.legend_type]) {
          legends[row.legend_type] = {
            qualified: true,
            count: 0,
            mints: [],
          };
        }

        legends[row.legend_type].count++;
        legends[row.legend_type].mints.push({
          name: row.name,
          txHash: row.tx_hash,
          blockNumber: row.block_number,
          blockTime: row.block_time,
          labelhash: row.labelhash,
          namehash: row.namehash,
        });
      }

      const response: APIResponse = {
        success: true,
        data: {
          address: normalizedAddress,
          legends,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch legend details',
      });
    }
  });
}
