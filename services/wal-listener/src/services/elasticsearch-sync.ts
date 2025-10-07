import { getElasticsearchClient, getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';

export class ElasticsearchSync {
  private esClient = getElasticsearchClient();
  private pool = getPostgresPool();

  async createIndex() {
    const indexName = config.elasticsearch.index;

    try {
      // Test Elasticsearch connection first
      const pingResponse = await this.esClient.ping();
      if (!pingResponse) {
        throw new Error('Failed to ping Elasticsearch');
      }
      logger.info('Successfully connected to Elasticsearch');

      const exists = await this.esClient.indices.exists({ index: indexName });

      if (!exists) {
        await this.esClient.indices.create({
          index: indexName,
          body: {
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
          },
        });

        logger.info(`Created Elasticsearch index: ${indexName}`);
      } else {
        logger.info(`Elasticsearch index already exists: ${indexName}`);
      }
    } catch (error) {
      logger.error('Failed to create Elasticsearch index:', error);
      throw error;
    }
  }

  async indexENSName(data: any) {
    try {
      const enrichedData = await this.enrichENSNameData(data);

      await this.esClient.index({
        index: config.elasticsearch.index,
        id: data.id?.toString() || data.token_id,
        body: enrichedData,
      });

      logger.debug(`Indexed ENS name: ${data.name}`);
    } catch (error) {
      logger.error(`Failed to index ENS name ${data.name}:`, error);
      throw error;
    }
  }

  async deleteENSName(id: string) {
    try {
      await this.esClient.delete({
        index: config.elasticsearch.index,
        id,
      });

      logger.debug(`Deleted ENS name from index: ${id}`);
    } catch (error) {
      logger.error(`Failed to delete ENS name ${id}:`, error);
      throw error;
    }
  }

  async updateENSNameListing(ensNameId: number) {
    try {
      const query = `
        SELECT
          en.*,
          l.price_wei as listing_price,
          l.status as listing_status,
          l.created_at as listing_created_at
        FROM ens_names en
        LEFT JOIN LATERAL (
          SELECT * FROM listings
          WHERE listings.ens_name_id = en.id
          AND listings.status = 'active'
          ORDER BY created_at DESC
          LIMIT 1
        ) l ON true
        WHERE en.id = $1
      `;

      const result = await this.pool.query(query, [ensNameId]);

      if (result.rows.length > 0) {
        await this.indexENSName(result.rows[0]);
      }
    } catch (error) {
      logger.error(`Failed to update listing for ENS name ${ensNameId}:`, error);
      throw error;
    }
  }

  async updateENSNameOffers(ensNameId: number) {
    try {
      const query = `
        SELECT
          en.*,
          COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'pending') as active_offers_count,
          MAX(o.offer_amount_wei) FILTER (WHERE o.status = 'pending') as highest_offer
        FROM ens_names en
        LEFT JOIN offers o ON o.ens_name_id = en.id
        WHERE en.id = $1
        GROUP BY en.id
      `;

      const result = await this.pool.query(query, [ensNameId]);

      if (result.rows.length > 0) {
        await this.esClient.update({
          index: config.elasticsearch.index,
          id: ensNameId.toString(),
          body: {
            doc: {
              active_offers_count: result.rows[0].active_offers_count,
              highest_offer: result.rows[0].highest_offer,
            },
          },
        });
      }
    } catch (error) {
      logger.error(`Failed to update offers for ENS name ${ensNameId}:`, error);
      throw error;
    }
  }

  async bulkSync() {
    logger.info('Starting bulk sync to Elasticsearch...');

    try {
      const query = `
        SELECT
          en.*,
          l.price_wei as listing_price,
          l.status as listing_status,
          l.created_at as listing_created_at,
          COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'pending') as active_offers_count,
          MAX(o.offer_amount_wei) FILTER (WHERE o.status = 'pending') as highest_offer
        FROM ens_names en
        LEFT JOIN LATERAL (
          SELECT * FROM listings
          WHERE listings.ens_name_id = en.id
          AND listings.status = 'active'
          ORDER BY created_at DESC
          LIMIT 1
        ) l ON true
        LEFT JOIN offers o ON o.ens_name_id = en.id
        GROUP BY en.id, l.price_wei, l.status, l.created_at
      `;

      const result = await this.pool.query(query);

      const bulkBody = [];
      for (const row of result.rows) {
        const enrichedData = await this.enrichENSNameData(row);
        bulkBody.push({
          index: {
            _index: config.elasticsearch.index,
            _id: row.id.toString(),
          },
        });
        bulkBody.push(enrichedData);
      }

      if (bulkBody.length > 0) {
        logger.info(`Preparing to bulk index ${result.rows.length} ENS names...`);

        // Process in smaller batches to avoid timeouts
        const batchSize = 1000; // Process 500 documents at a time (1000 bulk operations)
        for (let i = 0; i < bulkBody.length; i += batchSize) {
          const batch = bulkBody.slice(i, Math.min(i + batchSize, bulkBody.length));
          const docCount = batch.length / 2; // Each document has 2 entries in bulk body

          logger.info(`Processing batch: ${docCount} documents...`);

          const response = await this.esClient.bulk({
            body: batch,
            timeout: '60s', // Increase timeout for large batches
          });

          if (response.errors) {
            logger.error('Bulk indexing had errors:', JSON.stringify(response.items?.filter((item: any) => item.index?.error), null, 2));
          } else {
            logger.info(`Successfully indexed batch of ${docCount} documents`);
          }
        }

        logger.info(`Completed bulk indexing of ${result.rows.length} ENS names`);
      } else {
        logger.info('No ENS names to sync');
      }
    } catch (error: any) {
      logger.error(`Failed to perform bulk sync: ${error.message || error}`);
      if (error.meta?.body?.error) {
        logger.error('Elasticsearch error details:', JSON.stringify(error.meta.body.error, null, 2));
      }
      if (error.stack) {
        logger.error('Stack trace:', error.stack);
      }
      throw error;
    }
  }

  private async enrichENSNameData(data: any) {
    const name = data.name || '';

    return {
      name,
      token_id: data.token_id,
      owner: data.owner_address,
      price: data.listing_price || null,
      expiry_date: data.expiry_date,
      registration_date: data.registration_date,
      character_count: name.replace('.eth', '').length,
      has_numbers: /\d/.test(name),
      has_emoji: /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(name),
      status: data.listing_status || 'unlisted',
      tags: this.generateTags(name),
      last_sale_price: data.last_sale_price,
      listing_created_at: data.listing_created_at,
      active_offers_count: data.active_offers_count || 0,
      highest_offer: data.highest_offer || null,
    };
  }

  private generateTags(name: string): string[] {
    const tags: string[] = [];
    const cleanName = name.replace('.eth', '');

    if (cleanName.length <= 3) tags.push('short');
    if (cleanName.length === 4) tags.push('4-letter');
    if (cleanName.length === 5) tags.push('5-letter');
    if (/^\d+$/.test(cleanName)) tags.push('numeric');
    if (/^[a-z]+$/i.test(cleanName)) tags.push('alphabetic');
    if (/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(cleanName)) {
      tags.push('emoji');
    }

    return tags;
  }
}