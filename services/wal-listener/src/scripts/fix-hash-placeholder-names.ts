/**
 * Fix Hash-TokenID Placeholder Names
 *
 * Resolves the actual ENS names from The Graph for records with "#tokenId" format
 * and updates them with the real name, expiry, registration date, and owner.
 * Handles duplicates by merging records (like fix-token-ids.ts).
 *
 * Usage:
 *   npx tsx src/scripts/fix-hash-placeholder-names.ts
 *   npx tsx src/scripts/fix-hash-placeholder-names.ts --dry-run
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import axios from 'axios';

const pool = getPostgresPool();

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const DRY_RUN = process.argv.includes('--dry-run');

interface GraphDomain {
  id: string;
  name: string;
  labelhash: string;
  expiryDate: string | number;
  owner: { id: string };
  wrappedOwner: { id: string };
  registration?: {
    expiryDate: string;
    registrationDate: string;
  };
}

function hexToDecimal(hex: string): string {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + cleanHex).toString(10);
}

function decimalToHex(decimal: string): string {
  const hex = BigInt(decimal).toString(16).padStart(64, '0');
  return '0x' + hex;
}

/**
 * Query The Graph for domain by ID (the domain id in hex, e.g. 0xabc123...)
 */
async function queryGraphById(domainId: string): Promise<GraphDomain | null> {
  // Use domains query with id filter instead of domain(id:) since ensnode doesn't support ID type
  const query = `
    query GetDomainById($id: String!) {
      domains(where: { id: $id }, first: 1) {
        id
        name
        labelhash
        expiryDate
        owner { id }
        wrappedOwner { id }
        registration {
          expiryDate
          registrationDate
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      GRAPH_ENS_SUBGRAPH_URL,
      { query, variables: { id: domainId.toLowerCase() } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    if (response.data.errors) {
      console.error(`  GraphQL errors (by ID):`, response.data.errors);
      return null;
    }

    const domains = response.data.data?.domains || [];
    return domains.length > 0 ? domains[0] : null;
  } catch (error: any) {
    console.error(`  Error querying by ID:`, error.message);
    return null;
  }
}

/**
 * Query The Graph for domain by labelhash
 */
async function queryGraphByLabelhash(labelhash: string): Promise<GraphDomain | null> {
  const query = `
    query GetDomainByLabelhash($labelhash: String!) {
      domains(where: { labelhash: $labelhash, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }, first: 1) {
        id
        name
        labelhash
        expiryDate
        owner { id }
        wrappedOwner { id }
        registration {
          expiryDate
          registrationDate
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      GRAPH_ENS_SUBGRAPH_URL,
      { query, variables: { labelhash: labelhash.toLowerCase() } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    if (response.data.errors) {
      console.error(`  GraphQL errors (by labelhash):`, response.data.errors);
      return null;
    }

    const domains = response.data.data?.domains || [];
    return domains.length > 0 ? domains[0] : null;
  } catch (error: any) {
    console.error(`  Error querying by labelhash:`, error.message);
    return null;
  }
}

/**
 * Get correct token ID based on owner and expiry
 */
function getCorrectTokenId(domain: GraphDomain): string {
  const ownerAddress = domain.owner.id.toLowerCase();
  const isOwnedByWrapper = ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase();

  const expiryTimestamp = typeof domain.expiryDate === 'string'
    ? parseInt(domain.expiryDate)
    : domain.expiryDate;
  const isExpired = expiryTimestamp * 1000 < Date.now();

  if (isOwnedByWrapper && !isExpired) {
    return hexToDecimal(domain.id);
  }

  return hexToDecimal(domain.labelhash);
}

/**
 * Get owner address from domain
 */
function getOwnerAddress(domain: GraphDomain): string {
  const isOwnedByWrapper = domain.owner.id.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();
  return isOwnedByWrapper ? domain.wrappedOwner.id.toLowerCase() : domain.owner.id.toLowerCase();
}

async function fixHashPlaceholderNames() {
  console.log('Fix Hash-TokenID Placeholder Names');
  console.log('===================================');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  try {
    // Find all records with #tokenId format (# followed by only digits)
    // const findQuery = `
    //   SELECT id, name, token_id, owner_address
    //   FROM ens_names
    //   WHERE name ~ '^#[0-9]+$'
    //   ORDER BY created_at DESC
    // `;

    const findQuery = `
      SELECT id, name, token_id, owner_address
      FROM ens_names
      WHERE name LIKE 'token-%'
      ORDER BY created_at DESC
    `;

    const result = await pool.query(findQuery);
    console.log(`Found ${result.rows.length} records with #tokenId placeholder format\n`);

    if (result.rows.length === 0) {
      console.log('No records to fix. Exiting.');
      await closeAllConnections();
      process.exit(0);
    }

    let resolved = 0;
    let merged = 0;
    let converted = 0;
    let errors = 0;

    for (const row of result.rows) {
      // The token ID is the part after 'token-'
      const tokenIdFromName = row.name.substring(6);

      // Skip if this doesn't look like a numeric token ID (might already be resolved)
      if (!/^\d+$/.test(tokenIdFromName)) {
        console.log(`\nSkipping: ${row.name} (not a numeric placeholder)`);
        continue;
      }

      const labelhash = decimalToHex(tokenIdFromName);

      console.log(`\nProcessing: ${tokenIdFromName.substring(0, 50)}...`);
      console.log(`  DB id: ${row.id}, token_id: ${row.token_id?.substring(0, 20)}...`);
      console.log(`  Hex ID/labelhash: ${labelhash}`);

      // First try by ID (for wrapped names), then by labelhash
      console.log(`  Querying by ID...`);
      let domain = await queryGraphById(labelhash);
      if (!domain) {
        console.log(`  ID lookup failed, trying labelhash...`);
        domain = await queryGraphByLabelhash(labelhash);
      }

      if (!domain || !domain.name) {
        // Couldn't resolve - convert to token- format
        const newName = `token-${tokenIdFromName}`;
        if (!DRY_RUN) {
          await pool.query(
            `UPDATE ens_names SET name = $1, token_id = $2, updated_at = NOW() WHERE id = $3`,
            [newName, tokenIdFromName, row.id]
          );
        }
        console.log(`  → Converted to: ${newName.substring(0, 50)}...`);
        converted++;
        continue;
      }

      const correctName = domain.name;
      const correctTokenId = getCorrectTokenId(domain);
      const correctOwner = getOwnerAddress(domain);

      // Skip names that are too long for our varchar(255) column
      if (correctName.length > 255) {
        console.log(`  ⚠ Name too long (${correctName.length} chars), keeping as placeholder`);
        converted++;
        continue;
      }

      // Parse dates
      let expiryDate: Date | null = null;
      let registrationDate: Date | null = null;
      if (domain.registration?.expiryDate) {
        expiryDate = new Date(parseInt(domain.registration.expiryDate) * 1000);
      }
      if (domain.registration?.registrationDate) {
        registrationDate = new Date(parseInt(domain.registration.registrationDate) * 1000);
      }

      console.log(`  Resolved to: ${correctName}`);
      console.log(`  Correct token_id: ${correctTokenId.substring(0, 20)}...`);

      // Check for duplicates
      const duplicateCheck = await pool.query(
        'SELECT id, name, token_id FROM ens_names WHERE (name = $1 OR token_id = $2) AND id != $3',
        [correctName, correctTokenId, row.id]
      );

      if (duplicateCheck.rows.length > 0) {
        const dup = duplicateCheck.rows[0];
        console.log(`  Found duplicate: id=${dup.id}, name=${dup.name}`);

        // Current is placeholder (#...), duplicate might be real name or token- placeholder
        // Keep the one with the real name, or keep the duplicate if both are placeholders
        const currentIsPlaceholder = true; // We know current starts with #
        const dupIsPlaceholder = dup.name.startsWith('token-') || dup.name.startsWith('#');

        const keepId = dupIsPlaceholder ? row.id : dup.id;
        const deleteId = dupIsPlaceholder ? dup.id : row.id;

        console.log(`  Will keep id=${keepId}, delete id=${deleteId}`);

        if (!DRY_RUN) {
          await pool.query('BEGIN');
          try {
            await pool.query('SET LOCAL session_replication_role = replica');

            // Move foreign keys from delete record to keep record
            await pool.query('UPDATE listings SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);
            await pool.query('UPDATE offers SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);
            await pool.query('UPDATE sales SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);
            await pool.query('UPDATE activity_history SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);
            await pool.query('UPDATE watchlist SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);

            // Delete the record we don't want
            await pool.query('DELETE FROM ens_names WHERE id = $1', [deleteId]);

            // Update the kept record with correct data
            await pool.query(
              `UPDATE ens_names SET
                name = $1,
                token_id = $2,
                owner_address = $3,
                expiry_date = COALESCE($4, expiry_date),
                registration_date = COALESCE($5, registration_date),
                updated_at = NOW()
              WHERE id = $6`,
              [correctName, correctTokenId, correctOwner, expiryDate, registrationDate, keepId]
            );

            await pool.query('COMMIT');
            console.log(`  ✓ Merged records, kept id=${keepId}`);
          } catch (txError) {
            await pool.query('ROLLBACK');
            throw txError;
          }
        } else {
          console.log(`  [DRY RUN] Would merge records`);
        }
        merged++;
      } else {
        // No duplicate - just update
        if (!DRY_RUN) {
          await pool.query('BEGIN');
          try {
            await pool.query('SET LOCAL session_replication_role = replica');
            await pool.query(
              `UPDATE ens_names SET
                name = $1,
                token_id = $2,
                owner_address = $3,
                expiry_date = COALESCE($4, expiry_date),
                registration_date = COALESCE($5, registration_date),
                updated_at = NOW()
              WHERE id = $6`,
              [correctName, correctTokenId, correctOwner, expiryDate, registrationDate, row.id]
            );
            await pool.query('COMMIT');
            console.log(`  ✓ Updated to: ${correctName}`);
          } catch (txError) {
            await pool.query('ROLLBACK');
            throw txError;
          }
        } else {
          console.log(`  [DRY RUN] Would update to: ${correctName}`);
        }
        resolved++;
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('\n===================================');
    console.log('Summary:');
    console.log(`  Resolved to real names: ${resolved}`);
    console.log(`  Merged with duplicates: ${merged}`);
    console.log(`  Converted to token-:    ${converted}`);
    console.log(`  Errors:                 ${errors}`);
    console.log(`  Total processed:        ${result.rows.length}`);
    console.log('===================================\n');

    // Verify no records remain
    const verifyResult = await pool.query(`SELECT COUNT(*) FROM ens_names WHERE name ~ '^#[0-9]+$'`);
    const remaining = parseInt(verifyResult.rows[0].count);

    if (remaining === 0) {
      console.log('✓ All #tokenId placeholders have been fixed');
    } else {
      console.log(`⚠ ${remaining} records still have #tokenId format`);
    }

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('Error fixing placeholder names:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

fixHashPlaceholderNames();
