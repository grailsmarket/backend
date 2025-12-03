#!/usr/bin/env tsx
/**
 * Update ENS names data from The Graph
 *
 * Usage:
 *   npx tsx src/scripts/update-ens-names.ts
 *   npx tsx src/scripts/update-ens-names.ts --limit 100
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();

const GRAPH_URL = process.env.GRAPH_ENS_SUBGRAPH_URL || 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const GRAPH_API_KEY = process.env.GRAPH_API_KEY || '';

interface GraphNameData {
  name: string;
  expiryDate: Date | null;
  ownerAddress: string | null;
  registrationDate: Date | null;
  textRecords: Record<string, string>;
}

async function fetchNameDataFromGraph(tokenId: string): Promise<GraphNameData | null> {
  try {
    const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
    const labelhash = '0x' + hexString;

    const query = `
      query GetENSName($labelhash: String!) {
        domains(where: { labelhash: $labelhash, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }) {
          id
          name
          labelName
          labelhash
          registrant {
            id
          }
          wrappedOwner {
            id
          }
          registration {
            expiryDate
            registrationDate
          }
          resolver {
            textChangeds {
              value
              key
            }
          }
        }
      }
    `;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (GRAPH_API_KEY) {
      headers['Authorization'] = `Bearer ${GRAPH_API_KEY}`;
    }

    const response = await fetch(GRAPH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: { labelhash }
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as any;

    if (data.errors) {
      return null;
    }

    const domains = data.data?.domains || [];

    if (domains.length > 0) {
      const domain = domains[0];
      const name = domain.name || domain.labelName;

      if (name) {
        let expiryDate: Date | null = null;
        if (domain.registration?.expiryDate) {
          try {
            expiryDate = new Date(parseInt(domain.registration.expiryDate) * 1000);
          } catch (e) {}
        }

        let registrationDate: Date | null = null;
        if (domain.registration?.registrationDate) {
          try {
            registrationDate = new Date(parseInt(domain.registration.registrationDate) * 1000);
          } catch (e) {}
        }

        let ownerAddress: string | null = null;
        if (domain.wrappedOwner?.id) {
          ownerAddress = domain.wrappedOwner.id.toLowerCase();
        } else if (domain.registrant?.id) {
          ownerAddress = domain.registrant.id.toLowerCase();
        }

        const textRecords: Record<string, string> = {};
        if (domain.resolver?.textChangeds && Array.isArray(domain.resolver.textChangeds)) {
          for (const record of domain.resolver.textChangeds) {
            if (record.key && record.value) {
              textRecords[record.key] = record.value;
            }
          }
        }

        return { name, expiryDate, ownerAddress, registrationDate, textRecords };
      }
    }

    return null;
  } catch (error: any) {
    return null;
  }
}

async function updateENSName(id: number, data: GraphNameData): Promise<boolean> {
  try {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);

    if (data.ownerAddress) {
      updates.push(`owner_address = $${paramIndex++}`);
      values.push(data.ownerAddress);
    }

    if (data.expiryDate) {
      updates.push(`expiry_date = $${paramIndex++}`);
      values.push(data.expiryDate);
    }

    if (data.registrationDate) {
      updates.push(`registration_date = $${paramIndex++}`);
      values.push(data.registrationDate);
    }

    if (Object.keys(data.textRecords).length > 0) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(data.textRecords));
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    await pool.query(
      `UPDATE ens_names SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
    return true;
  } catch (error: any) {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let maxRecords: number | null = null;

  if (args.includes('--limit')) {
    const limitIndex = args.indexOf('--limit');
    maxRecords = parseInt(args[limitIndex + 1], 10);
  }

  console.log('🚀 Starting ENS names update script');
  console.log(`   Max records: ${maxRecords || 'unlimited'}`);
  console.log('');

  try {
    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) as total FROM ens_names');
    const totalCount = Math.min(
      parseInt(countResult.rows[0].total),
      maxRecords || Infinity
    );

    console.log(`📝 Total records to process: ${totalCount}`);
    console.log('');

    let updated = 0;
    let failed = 0;
    let processed = 0;
    const batchSize = 50;

    while (processed < totalCount) {
      // Fetch small batch
      const result = await pool.query(
        'SELECT id, token_id, name FROM ens_names ORDER BY id DESC LIMIT $1 OFFSET $2',
        [batchSize, processed]
      );

      if (result.rows.length === 0) break;

      // Process each record in batch
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];

        try {
          const graphData = await fetchNameDataFromGraph(row.token_id);

          if (graphData) {
            const success = await updateENSName(row.id, graphData);
            if (success) {
              updated++;
              console.log(`  ✓ ${graphData.name} (${processed + i + 1}/${totalCount})`);
            } else {
              failed++;
            }
          }

          // Delay every 5 records to avoid rate limiting
        //   if ((processed + i + 1) % 5 === 0) {
        //     await new Promise(resolve => setTimeout(resolve, 200));
        //   }
        } catch (error: any) {
          failed++;
        }
      }

      processed += result.rows.length;
    }

    console.log('');
    console.log('✨ Update complete!');
    console.log(`   Updated: ${updated}`);
    console.log(`   Failed: ${failed}`);

    await closeAllConnections();
    process.exit(0);
  } catch (error: any) {
    console.error('💥 Fatal error:', error?.message);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
