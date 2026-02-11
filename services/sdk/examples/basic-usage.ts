/**
 * Basic Usage Example
 *
 * This example shows how to use the Grails SDK for basic operations
 * like searching for names and viewing listings.
 */

import { GrailsClient } from '@grails/sdk';

async function main() {
  // Create a client (no authentication needed for read operations)
  const grails = new GrailsClient();

  // Search for ENS names
  console.log('Searching for 3-letter names with active listings...\n');

  const searchResults = await grails.search.search({
    minLength: 3,
    maxLength: 3,
    showListings: true,
    sortBy: 'price',
    sortOrder: 'asc',
    limit: 10,
  });

  console.log(`Found ${searchResults.pagination.total} names`);
  console.log('First 10 results:');

  for (const result of searchResults.results) {
    const listing = result.listings[0];
    const priceEth = listing
      ? (BigInt(listing.price_wei) / BigInt(10 ** 18)).toString()
      : 'Not listed';

    console.log(`  ${result.name} - ${priceEth} ETH`);
  }

  // Get details for a specific name
  console.log('\nGetting details for vitalik.eth...');

  try {
    const nameDetails = await grails.names.get('vitalik.eth');
    console.log(`  Owner: ${nameDetails.owner_address}`);
    console.log(`  Expiry: ${nameDetails.expiry_date}`);
    console.log(`  Watchers: ${nameDetails.watchers_count}`);
    console.log(`  Clubs: ${nameDetails.clubs.join(', ') || 'None'}`);
  } catch (error) {
    console.log('  Name not found or error occurred');
  }

  // List recent listings
  console.log('\nGetting recent listings...');

  const listings = await grails.listings.list({
    status: 'active',
    sort: 'created',
    order: 'desc',
    limit: 5,
  });

  console.log(`Found ${listings.pagination.total} active listings`);
  for (const listing of listings.listings) {
    const priceEth = (BigInt(listing.price_wei) / BigInt(10 ** 18)).toString();
    console.log(`  ${listing.ens_name} - ${priceEth} ETH`);
  }
}

main().catch(console.error);
