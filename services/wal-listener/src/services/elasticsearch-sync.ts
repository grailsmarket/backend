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
                clubs: { type: 'keyword' },
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
                // Expiration state fields
                is_expired: { type: 'boolean' },
                is_grace_period: { type: 'boolean' },
                is_premium_period: { type: 'boolean' },
                days_until_expiry: { type: 'integer' },
                premium_amount_eth: {
                  type: 'scaled_float',
                  scaling_factor: 1000000000000000000,
                },
                // Sale history fields
                last_sale_date: { type: 'date' },
                has_sales: { type: 'boolean' },
                days_since_last_sale: { type: 'integer' },
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
          l.created_at as listing_created_at,
          en.last_sale_date
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
      // First, get total count
      const countResult = await this.pool.query('SELECT COUNT(*) as total FROM ens_names');
      const totalRows = parseInt(countResult.rows[0].total);
      logger.info(`Total ENS names to sync: ${totalRows}`);

      // Process in database-level batches to avoid loading everything into memory
      const dbBatchSize = 100; // Fetch 100 rows from DB at a time (reduced for memory)
      let processed = 0;
      let offset = 0;

      while (offset < totalRows) {
        // Query one batch at a time from database
        const query = `
          SELECT
            en.*,
            l.price_wei as listing_price,
            l.status as listing_status,
            l.created_at as listing_created_at,
            COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'pending') as active_offers_count,
            MAX(o.offer_amount_wei) FILTER (WHERE o.status = 'pending') as highest_offer,
            en.last_sale_date
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
          ORDER BY en.id
          LIMIT $1 OFFSET $2
        `;

        const result = await this.pool.query(query, [dbBatchSize, offset]);

        if (result.rows.length === 0) {
          break; // No more rows
        }

        // Build bulk body for this batch only
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

        // Send this batch to Elasticsearch
        logger.info(`Processing batch: ${result.rows.length} documents (${processed + 1}-${processed + result.rows.length} of ${totalRows})...`);

        const response = await this.esClient.bulk({
          body: bulkBody,
          timeout: '60s',
        });

        if (response.errors) {
          const errors = response.items?.filter((item: any) => item.index?.error);
          logger.error(`Bulk indexing had ${errors?.length || 0} errors:`, JSON.stringify(errors?.slice(0, 5), null, 2));
        } else {
          logger.info(`Successfully indexed batch of ${result.rows.length} documents`);
        }

        processed += result.rows.length;
        offset += dbBatchSize;

        // Delay to allow garbage collection and prevent overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      logger.info(`Completed bulk indexing of ${processed} ENS names`);
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
    const expirationState = this.calculateExpirationState(data.expiry_date);
    const saleHistoryState = this.calculateSaleHistoryState(data.last_sale_date);

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
      clubs: data.clubs || [],
      last_sale_price: data.last_sale_price,
      listing_created_at: data.listing_created_at,
      active_offers_count: data.active_offers_count || 0,
      highest_offer: data.highest_offer || null,
      // Expiration state fields
      is_expired: expirationState.isExpired,
      is_grace_period: expirationState.isGracePeriod,
      is_premium_period: expirationState.isPremiumPeriod,
      days_until_expiry: expirationState.daysUntilExpiry,
      premium_amount_eth: expirationState.premiumAmountEth,
      // Sale history fields
      last_sale_date: saleHistoryState.lastSaleDate,
      has_sales: saleHistoryState.hasSales,
      days_since_last_sale: saleHistoryState.daysSinceLastSale,
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

  /**
   * Calculate expiration state for an ENS name
   * - Grace Period: 90 days after expiry where owner can renew
   * - Premium Period: 21 days after grace period with declining Dutch auction
   * - Premium starts at ~$100M and declines exponentially to $0
   */
  private calculateExpirationState(expiryDate: string | null): {
    isExpired: boolean;
    isGracePeriod: boolean;
    isPremiumPeriod: boolean;
    daysUntilExpiry: number;
    premiumAmountEth: number | null;
  } {
    if (!expiryDate) {
      return {
        isExpired: false,
        isGracePeriod: false,
        isPremiumPeriod: false,
        daysUntilExpiry: 999999,
        premiumAmountEth: null,
      };
    }

    const now = new Date();
    const expiry = new Date(expiryDate);
    const daysSinceExpiry = Math.floor((now.getTime() - expiry.getTime()) / (1000 * 60 * 60 * 24));
    const daysUntilExpiry = -daysSinceExpiry;

    // Not expired yet
    if (daysSinceExpiry < 0) {
      return {
        isExpired: false,
        isGracePeriod: false,
        isPremiumPeriod: false,
        daysUntilExpiry,
        premiumAmountEth: null,
      };
    }

    // Grace period: 0-90 days after expiry
    if (daysSinceExpiry <= 90) {
      return {
        isExpired: true,
        isGracePeriod: true,
        isPremiumPeriod: false,
        daysUntilExpiry,
        premiumAmountEth: null,
      };
    }

    // Premium period: 91-111 days after expiry (21 days)
    const daysIntoPremium = daysSinceExpiry - 90;
    if (daysIntoPremium <= 21) {
      // Calculate premium using exponential decay
      // Premium starts at $100,000,000 and decays to $0 over 21 days
      // Using exponential decay: premium = initialPremium * e^(-k * days)
      // Where k is chosen so that premium ≈ 0 at day 21
      const initialPremiumUSD = 100000000; // $100M
      const ethPriceUSD = 2000; // Approximate ETH price (could be fetched from oracle)
      const initialPremiumETH = initialPremiumUSD / ethPriceUSD;

      // Decay constant: ln(10000) / 21 ≈ 0.438 (drops to 1/10000th by day 21)
      const k = Math.log(10000) / 21;
      const premiumAmountEth = initialPremiumETH * Math.exp(-k * daysIntoPremium);

      return {
        isExpired: true,
        isGracePeriod: false,
        isPremiumPeriod: true,
        daysUntilExpiry,
        premiumAmountEth,
      };
    }

    // After premium period: fully available for normal registration
    return {
      isExpired: true,
      isGracePeriod: false,
      isPremiumPeriod: false,
      daysUntilExpiry,
      premiumAmountEth: null,
    };
  }

  /**
   * Calculate sale history state for an ENS name
   * Returns whether the name has been sold and how long ago
   */
  private calculateSaleHistoryState(lastSaleDate: string | null): {
    lastSaleDate: string | null;
    hasSales: boolean;
    daysSinceLastSale: number | null;
  } {
    if (!lastSaleDate) {
      return {
        lastSaleDate: null,
        hasSales: false,
        daysSinceLastSale: null,
      };
    }

    const now = new Date();
    const saleDate = new Date(lastSaleDate);
    const daysSinceLastSale = Math.floor((now.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24));

    return {
      lastSaleDate,
      hasSales: true,
      daysSinceLastSale,
    };
  }
}