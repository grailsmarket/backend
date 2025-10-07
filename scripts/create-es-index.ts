#!/usr/bin/env npx tsx
import { getElasticsearchClient, config, closeAllConnections } from '../services/shared/src';

async function createIndex() {
  console.log('Creating Elasticsearch index...');

  const esClient = getElasticsearchClient();
  const indexName = config.elasticsearch.index;

  try {
    // Check if index exists
    const exists = await esClient.indices.exists({ index: indexName });

    if (exists) {
      console.log(`Index ${indexName} already exists. Deleting...`);
      await esClient.indices.delete({ index: indexName });
    }

    // Create index with correct settings
    await esClient.indices.create({
      index: indexName,
      body: {
        settings: {
          index: {
            max_ngram_diff: 8,  // Allow difference of 8 between min and max
          },
          analysis: {
            analyzer: {
              ngram_analyzer: {
                type: 'custom',
                tokenizer: 'ngram_tokenizer',
                filter: ['lowercase'],
              },
            },
            tokenizer: {
              ngram_tokenizer: {
                type: 'ngram',
                min_gram: 2,
                max_gram: 10,
                token_chars: ['letter', 'digit'],
              },
            },
          },
        },
        mappings: {
          properties: {
            name: {
              type: 'text',
              fields: {
                keyword: { type: 'keyword' },
                ngram: {
                  type: 'text',
                  analyzer: 'ngram_analyzer',
                },
              },
            },
            token_id: { type: 'keyword' },
            owner: { type: 'keyword' },
            price: {
              type: 'scaled_float',
              scaling_factor: 1000000000000000000,
            },
            expiry_date: { type: 'date' },
            registration_date: { type: 'date' },
            character_count: { type: 'integer' },
            has_numbers: { type: 'boolean' },
            has_emoji: { type: 'boolean' },
            status: { type: 'keyword' },
            tags: { type: 'keyword' },
            last_sale_price: {
              type: 'scaled_float',
              scaling_factor: 1000000000000000000,
            },
            listing_created_at: { type: 'date' },
            active_offers_count: { type: 'integer' },
            highest_offer: {
              type: 'scaled_float',
              scaling_factor: 1000000000000000000,
            },
          },
        },
      },
    });

    console.log(`Successfully created index: ${indexName}`);

    // Test the connection
    const health = await esClient.cluster.health();
    console.log('Cluster health:', health.status);

  } catch (error: any) {
    console.error('Error creating index:', error?.message || error);
    if (error?.meta?.body?.error) {
      console.error('Elasticsearch error:', JSON.stringify(error.meta.body.error, null, 2));
    }
  } finally {
    await closeAllConnections();
  }
}

createIndex();