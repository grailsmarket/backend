/**
 * Generate a test JWT token for local development/testing
 *
 * Usage:
 *   npx tsx scripts/generate-test-token.ts
 *   npx tsx scripts/generate-test-token.ts 0xYourAddress
 *
 * This script:
 * 1. Creates or finds a test user in the database
 * 2. Generates a valid JWT token for that user
 * 3. Prints the token and example curl commands
 */

import { getPostgresPool } from '../../shared/src';
import { generateToken } from '../src/middleware/auth';

const DEFAULT_TEST_ADDRESS = '0x0000000000000000000000000000000000000001';

async function main() {
  const address = (process.argv[2] || DEFAULT_TEST_ADDRESS).toLowerCase();

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    console.error('Invalid Ethereum address format');
    process.exit(1);
  }

  const pool = getPostgresPool();

  try {
    // Upsert test user
    const userResult = await pool.query(
      `INSERT INTO users (address, last_sign_in)
       VALUES ($1, NOW())
       ON CONFLICT (address)
       DO UPDATE SET last_sign_in = NOW()
       RETURNING *`,
      [address]
    );

    const user = userResult.rows[0];
    console.log(`\nUser: id=${user.id}, address=${user.address}\n`);

    // Generate token
    const token = generateToken(user.id, user.address);

    console.log('='.repeat(60));
    console.log('JWT Token:');
    console.log('='.repeat(60));
    console.log(token);
    console.log('='.repeat(60));

    console.log('\nExample usage:\n');
    console.log(`export TOKEN="${token}"\n`);

    console.log('# Test auth');
    console.log(`curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/auth/me\n`);

    console.log('# Export search results');
    console.log(`curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/export?filters[showListings]=true&limit=100" -o export.csv\n`);

    console.log('# Export with filters');
    console.log(`curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/export?filters[clubs][]=999&filters[minLength]=3" -o 999-club.csv\n`);

    console.log('# Export watchlist');
    console.log(`curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/watchlist/export" -o watchlist.csv\n`);

  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
