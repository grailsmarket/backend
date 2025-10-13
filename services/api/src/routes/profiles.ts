import { FastifyInstance } from 'fastify';
import { getPostgresPool, APIResponse, config } from '../../../shared/src';
import { ethers } from 'ethers';

export async function profilesRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // ENS Name Wrapper contract address
  const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

  // Name Wrapper ABI - just the ownerOf function we need
  const NAME_WRAPPER_ABI = [
    'function ownerOf(uint256 id) view returns (address)'
  ];

  /**
   * Get the actual owner of a wrapped ENS name by querying the Name Wrapper contract
   */
  async function getWrappedNameOwner(ensName: string): Promise<string | null> {
    try {
      const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
      const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

      // Compute namehash for the ENS name
      const namehash = ethers.namehash(ensName);

      // Call ownerOf on the Name Wrapper contract
      const owner = await nameWrapper.ownerOf(namehash);

      fastify.log.info({ ensName, namehash, owner }, 'Retrieved owner from Name Wrapper contract');

      return owner.toLowerCase();
    } catch (error: any) {
      fastify.log.error({ error, ensName }, 'Error querying Name Wrapper contract');
      return null;
    }
  }

  /**
   * Fetch ENS name from The Graph and create database record
   */
  async function fetchAndCreateEnsName(ensName: string): Promise<{ tokenId: string; ownerAddress: string } | null> {
    try {
      const query = `
        query GetENSName($name: String!) {
          domains(where: { name: $name }) {
            id
            name
            labelName
            labelhash
            owner {
              id
            }
            registrant {
              id
            }
            wrappedOwner {
              id
            }
            resolver {
              id
              addr {
                id
              }
            }
            expiryDate
            createdAt
          }
        }
      `;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (config.theGraph?.apiKey) {
        headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
      }

      const response = await fetch(config.theGraph.ensSubgraphUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          variables: { name: ensName }
        }),
      });

      if (!response.ok) {
        fastify.log.error({ status: response.status }, 'The Graph API error');
        return null;
      }

      const data = await response.json() as any;

      if (data.errors) {
        fastify.log.error({ errors: data.errors }, 'The Graph query errors');
        return null;
      }

      const domains = data.data?.domains || [];

      if (domains.length === 0) {
        return null;
      }

      const domain = domains[0];

      // Priority for finding owner:
      // 1. wrappedOwner - for wrapped names, this is the actual owner
      // 2. resolver.addr.id - the address the name resolves to
      // 3. registrant - the registrant address
      // 4. owner - fallback to owner field
      const ownerAddress = domain.wrappedOwner?.id || domain.resolver?.addr?.id || domain.registrant?.id || domain.owner?.id;

      if (!ownerAddress) {
        fastify.log.warn({ ensName }, 'No owner found for ENS name');
        return null;
      }

      // Convert labelhash to token_id (decimal string)
      const labelhash = domain.labelhash;
      const tokenId = BigInt(labelhash).toString();

      // Fetch ENS records from EFP API
      let metadata = null;
      try {
        const efpResponse = await fetch(`https://api.ethfollow.xyz/api/v1/users/${ensName}/details`);
        if (efpResponse.ok) {
          const efpData: any = await efpResponse.json();

          if (efpData.ens?.records) {
            const records = efpData.ens.records;
            metadata = {
              avatar: records.avatar,
              name: records.name,
              description: records.description,
              email: records.email,
              url: records.url,
              location: records.location,
              twitter: records['com.twitter'],
              github: records['com.github'],
              discord: records['com.discord'],
              telegram: records['org.telegram'],
              header: records.header,
              contentHash: records.contentHash,
              records: records,
            };
            fastify.log.info({ ensName }, 'Fetched ENS records from EFP API');
          }
        }
      } catch (error: any) {
        fastify.log.warn({ error, ensName }, 'Failed to fetch ENS records from EFP API');
      }

      // Insert into database
      const insertQuery = `
        INSERT INTO ens_names (
          token_id,
          name,
          owner_address,
          expiry_date,
          registration_date,
          metadata,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (token_id) DO UPDATE SET
          name = EXCLUDED.name,
          owner_address = EXCLUDED.owner_address,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING id
      `;

      const expiryDate = domain.expiryDate ? new Date(parseInt(domain.expiryDate) * 1000) : null;
      const createdAt = domain.createdAt ? new Date(parseInt(domain.createdAt) * 1000) : null;

      await pool.query(insertQuery, [
        tokenId,
        ensName,
        ownerAddress.toLowerCase(),
        expiryDate,
        createdAt,
        metadata ? JSON.stringify(metadata) : null
      ]);

      fastify.log.info({ ensName, tokenId, ownerAddress }, 'Created ENS name from The Graph with metadata');

      return { tokenId, ownerAddress: ownerAddress.toLowerCase() };
    } catch (error: any) {
      fastify.log.error({ error, ensName }, 'Error fetching ENS name from The Graph');
      return null;
    }
  }

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
          // Not found in database, try to fetch from The Graph
          fastify.log.info({ ensName: addressOrName }, 'ENS name not found in database, fetching from The Graph');

          const graphResult = await fetchAndCreateEnsName(addressOrName);

          if (!graphResult) {
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

          ownerAddress = graphResult.ownerAddress;
        } else {
          ownerAddress = nameResult.rows[0].owner_address?.toLowerCase();

          // Check if the owner is the Name Wrapper contract
          if (ownerAddress === NAME_WRAPPER_ADDRESS) {
            fastify.log.info({ ensName: addressOrName }, 'Owner is Name Wrapper contract, fetching correct owner');

            // First try fetching from The Graph (which includes resolver.addr.id)
            const graphResult = await fetchAndCreateEnsName(addressOrName);

            if (graphResult && graphResult.ownerAddress !== NAME_WRAPPER_ADDRESS) {
              ownerAddress = graphResult.ownerAddress;
              fastify.log.info({ ensName: addressOrName, newOwner: ownerAddress }, 'Updated owner from Name Wrapper via The Graph');
            } else {
              // If The Graph didn't help, query Name Wrapper contract directly
              fastify.log.info({ ensName: addressOrName }, 'Querying Name Wrapper contract directly');
              const wrappedOwner = await getWrappedNameOwner(addressOrName);

              if (wrappedOwner && wrappedOwner !== NAME_WRAPPER_ADDRESS) {
                ownerAddress = wrappedOwner;

                // Update database with the correct owner
                await pool.query(
                  'UPDATE ens_names SET owner_address = $1, updated_at = NOW() WHERE LOWER(name) = LOWER($2)',
                  [wrappedOwner, addressOrName]
                );

                fastify.log.info({ ensName: addressOrName, newOwner: ownerAddress }, 'Updated owner from Name Wrapper via contract call');
              } else {
                fastify.log.warn({ ensName: addressOrName }, 'Failed to fetch correct owner');
              }
            }
          }

          if (!ownerAddress || ownerAddress === NAME_WRAPPER_ADDRESS) {
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
