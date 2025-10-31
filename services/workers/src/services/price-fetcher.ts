import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const COINGECKO_API = 'https://api.coingecko.com/api/v3';

export class PriceFetcher {
  private pool = getPostgresPool();

  /**
   * Fetch current ETH price from CoinGecko and store in database
   */
  async fetchAndStoreEthPrice(): Promise<number> {
    try {
      logger.info('Fetching ETH price from CoinGecko...');

      // CoinGecko free API - no auth needed
      const response = await fetch(
        `${COINGECKO_API}/simple/price?ids=ethereum&vs_currencies=usd&precision=8`
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
      }

      const data: any = await response.json();
      const ethPrice = data.ethereum?.usd;

      if (!ethPrice || typeof ethPrice !== 'number') {
        throw new Error('No ETH price in CoinGecko response');
      }

      logger.info({ ethPrice }, 'Fetched ETH price from CoinGecko');

      // Store in database with timestamp of fetch
      await this.pool.query(`
        INSERT INTO price_feeds (token_symbol, quote_currency, price, source, timestamp)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (token_symbol, quote_currency, timestamp) DO UPDATE
        SET price = EXCLUDED.price
      `, ['ETH', 'USD', ethPrice, 'coingecko']);

      logger.info({ ethPrice, timestamp: new Date() }, '✅ Stored ETH price in database');

      return ethPrice;
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack }, '❌ Failed to fetch ETH price');
      throw error;
    }
  }

  /**
   * Get the latest ETH price from our database (for use in triggers/calculations)
   * Returns the most recent price we have on record
   */
  async getLatestEthPrice(): Promise<number | null> {
    try {
      const result = await this.pool.query(`
        SELECT price, timestamp FROM latest_prices
        WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
      `);

      if (result.rows.length === 0) {
        logger.warn('No ETH price found in database');
        return null;
      }

      const price = parseFloat(result.rows[0].price);
      const timestamp = result.rows[0].timestamp;

      logger.debug({ price, timestamp }, 'Retrieved latest ETH price from database');

      return price;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error getting latest ETH price from database');
      throw error;
    }
  }

  /**
   * Get historical ETH price at a specific timestamp
   * Returns the most recent price at or before that timestamp
   */
  async getEthPriceAtTime(timestamp: Date): Promise<number | null> {
    try {
      const result = await this.pool.query(`
        SELECT price, timestamp FROM price_feeds
        WHERE token_symbol = 'ETH'
          AND quote_currency = 'USD'
          AND timestamp <= $1
        ORDER BY timestamp DESC
        LIMIT 1
      `, [timestamp]);

      if (result.rows.length === 0) {
        logger.warn({ timestamp }, 'No historical ETH price found for timestamp');
        // Fallback to latest price
        return this.getLatestEthPrice();
      }

      const price = parseFloat(result.rows[0].price);
      const priceTimestamp = result.rows[0].timestamp;

      logger.debug({ price, timestamp: priceTimestamp, requestedTimestamp: timestamp }, 'Retrieved historical ETH price');

      return price;
    } catch (error: any) {
      logger.error({ error: error.message, timestamp }, 'Error getting historical ETH price');
      throw error;
    }
  }

  /**
   * Get statistics about price data in the database
   */
  async getPriceStats(): Promise<{
    count: number;
    oldest: Date | null;
    newest: Date | null;
    latestPrice: number | null;
  }> {
    try {
      const result = await this.pool.query(`
        SELECT
          COUNT(*) as count,
          MIN(timestamp) as oldest,
          MAX(timestamp) as newest,
          (SELECT price FROM latest_prices WHERE token_symbol = 'ETH' AND quote_currency = 'USD') as latest_price
        FROM price_feeds
        WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
      `);

      const row = result.rows[0];

      return {
        count: parseInt(row.count),
        oldest: row.oldest,
        newest: row.newest,
        latestPrice: row.latest_price ? parseFloat(row.latest_price) : null,
      };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error getting price stats');
      throw error;
    }
  }
}
