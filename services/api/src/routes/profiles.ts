import { FastifyInstance } from 'fastify';
import { getPostgresPool, APIResponse } from '../../../shared/src';

export async function profilesRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/profiles/:addressOrName
   * Get profile data for an address or ENS name
   * Includes primary ENS name, ENS records, owned names, and activity
   */
  fastify.get('/:addressOrName', async (request, reply) => {
    const { addressOrName } = request.params as { addressOrName: string };

    try {
      // Determine if input is an address or ENS name
      const isAddress = /^0x[a-fA-F0-9]{40}$/.test(addressOrName);

      let ownerAddress: string;
      let primaryName: string | null = null;

      if (isAddress) {
        ownerAddress = addressOrName.toLowerCase();
      } else {
        // Input is an ENS name, find the owner
        const nameQuery = `
          SELECT owner_address, name FROM ens_names
          WHERE LOWER(name) = LOWER($1)
        `;
        const nameResult = await pool.query(nameQuery, [addressOrName]);

        if (nameResult.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: {
              code: 'PROFILE_NOT_FOUND',
              message: `No profile found for "${addressOrName}"`,
            },
            meta: {
              timestamp: new Date().toISOString(),
            },
          });
        }

        ownerAddress = nameResult.rows[0].owner_address?.toLowerCase();
        if (!ownerAddress) {
          return reply.status(404).send({
            success: false,
            error: {
              code: 'INVALID_ADDRESS',
              message: `ENS name "${addressOrName}" has no valid owner address`,
            },
            meta: {
              timestamp: new Date().toISOString(),
            },
          });
        }
      }

      // Fetch primary name and ENS records from EFP API
      // EFP API automatically returns the primary name for any address
      let ensRecords = null;
      try {
        const efpResponse = await fetch(`https://api.ethfollow.xyz/api/v1/users/${ownerAddress}/details`);
        if (efpResponse.ok) {
          const efpData: any = await efpResponse.json();

          // EFP API returns the primary name for this address
          if (efpData.ens?.name) {
            primaryName = efpData.ens.name;
          }

          // Extract ENS records
          if (efpData.ens?.records) {
            const records = efpData.ens.records;
            ensRecords = {
              avatar: records.avatar,
              name: records.name,
              description: records.description,
              email: records.email,
              url: records.url,
              location: records.location,
              twitter: records['com.twitter'],
              github: records['com.github'],
              header: records.header,
              address: efpData.address,
              records: records,
            };
          }
        }
      } catch (error: any) {
        fastify.log.warn('Failed to fetch ENS records from EFP API:', error);
      }

      // Fetch owned ENS names with listing status
      const ownedNamesQuery = `
        SELECT
          en.id,
          en.token_id,
          en.name,
          en.expiry_date,
          en.registration_date,
          en.created_at,
          EXISTS (
            SELECT 1 FROM listings l
            WHERE l.ens_name_id = en.id AND l.status = 'active'
          ) as is_listed,
          (
            SELECT json_build_object(
              'id', l.id,
              'price_wei', l.price_wei,
              'currency_address', l.currency_address,
              'source', l.source,
              'created_at', l.created_at
            )
            FROM listings l
            WHERE l.ens_name_id = en.id AND l.status = 'active'
            ORDER BY l.created_at DESC
            LIMIT 1
          ) as active_listing
        FROM ens_names en
        WHERE LOWER(en.owner_address) = $1
        ORDER BY en.created_at DESC
      `;

      const ownedNamesResult = await pool.query(ownedNamesQuery, [ownerAddress]);

      // Get activity count for this address
      const activityCountQuery = `
        SELECT COUNT(*) as total
        FROM activity_history
        WHERE actor_address = $1 OR counterparty_address = $1
      `;
      const activityCountResult = await pool.query(activityCountQuery, [ownerAddress]);

      const response: APIResponse = {
        success: true,
        data: {
          address: ownerAddress,
          primaryName,
          ensRecords,
          ownedNames: ownedNamesResult.rows,
          stats: {
            totalNames: ownedNamesResult.rows.length,
            listedNames: ownedNamesResult.rows.filter(n => n.is_listed).length,
            totalActivity: parseInt(activityCountResult.rows[0].total),
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching profile:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch profile',
          details: error.message,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
