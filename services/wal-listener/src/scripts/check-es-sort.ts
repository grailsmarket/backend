#!/usr/bin/env tsx
import { getElasticsearchClient, closeAllConnections } from '../../../shared/src';

const es = getElasticsearchClient();

async function main() {
  // Get sort order from command line args (default to asc)
  const sortOrder = (process.argv[2] || 'asc') as 'asc' | 'desc';

  // Get ES results sorted by price
  const esResult = await es.search({
    index: 'ens_names',
    size: 20,
    body: {
      query: {
        bool: {
          must: [
            { term: { status: 'active' } },
            { term: { is_expired: false } }
          ]
        }
      },
      sort: [
        { price: { order: sortOrder } }
      ],
      _source: ['name', 'price']
    }
  });

  console.log(`ES results sorted by price ${sortOrder.toUpperCase()}:\n`);
  console.log('(ES internal sort values shown)\n');

  const results = [];
  for (const hit of esResult.hits.hits) {
    const name = (hit._source as any).name;
    const price = (hit._source as any).price;
    const sortValue = hit.sort ? hit.sort[0] : null;

    results.push({ name, price, sortValue });

    // Price is already in ETH (scaled_float), no need to divide
    const priceEth = price ? parseFloat(price).toFixed(4) : 'N/A';
    console.log(`${name.padEnd(25)} Price: ${priceEth.padStart(10)} ETH | Sort value: ${sortValue}`);
  }

  // Now let's manually check if the prices are sorted
  console.log('\n\nManual sort check (by actual price field):');
  const sorted = sortOrder === 'asc'
    ? [...results].sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
    : [...results].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  
  let correct = true;
  for (let i = 0; i < 10; i++) {
    const actual = results[i];
    const expected = sorted[i];
    const match = actual.name === expected.name ? '✓' : '✗';
    const actualEth = parseFloat(actual.price).toFixed(4);
    const expectedEth = parseFloat(expected.price).toFixed(4);

    if (match === '✗') correct = false;

    console.log(`${match} Position ${i+1}: Got ${actual.name} (${actualEth} ETH), Expected ${expected.name} (${expectedEth} ETH)`);
  }

  if (!correct) {
    console.log('\n❌ ES is NOT sorting correctly by price field!');
  } else {
    console.log('\n✅ ES is sorting correctly');
  }

  await closeAllConnections();
}

main();
