#!/usr/bin/env tsx
import { getElasticsearchClient, closeAllConnections } from '../../../shared/src';

const es = getElasticsearchClient();

async function main() {
  // Get a few records with active status and not expired
  const result = await es.search({
    index: 'ens_names',
    size: 5,
    body: {
      query: {
        bool: {
          must: [
            { term: { status: 'active' } },
            { term: { is_expired: false } }
          ]
        }
      },
      sort: [{ price: { order: 'asc' } }],
      _source: ['name', 'price']
    }
  });

  console.log('Raw ES documents after resync:\n');
  
  for (const hit of result.hits.hits) {
    const price = (hit._source as any).price;
    const sortValue = hit.sort ? hit.sort[0] : 'N/A';
    
    console.log(`ID: ${hit._id}`);
    console.log(`Name: ${(hit._source as any).name}`);
    console.log(`Price (raw): ${JSON.stringify(price)}`);
    console.log(`Price type: ${typeof price}`);
    console.log(`Sort value: ${sortValue}`);
    console.log('');
  }

  await closeAllConnections();
}

main();
