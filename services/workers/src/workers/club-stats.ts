import PgBoss from 'pg-boss';
import { logger } from '../utils/logger';
import { getPostgresPool, ETH_WETH_FILTER } from '../../../shared/src';

const pool = getPostgresPool();

export interface UpdateClubFloorPriceJob {
  clubNames: string[];
  eventType: 'create' | 'update' | 'delete';
  listingPrice?: string;
}

export interface UpdateClubSalesStatsJob {
  clubNames: string[];
  salePriceWei: string;
}

export interface RecalculateClubStatsJob {
  clubName: string;
}

/**
 * Recalculate floor price for a club from scratch by querying active listings
 */
async function recalculateFloorPrice(clubName: string): Promise<void> {
  logger.info({ clubName }, 'Recalculating floor price for club');

  try {
    // Find minimum active listing price for club members (ETH and WETH)
    const result = await pool.query(
      `
      SELECT MIN(l.price_wei::numeric) as floor_price,
             l.currency_address
      FROM listings l
      JOIN ens_names e ON l.ens_name_id = e.id
      WHERE l.status = 'active'
        AND $1 = ANY(e.clubs)
        AND ${ETH_WETH_FILTER}
      GROUP BY l.currency_address
      `,
      [clubName]
    );

    if (result.rows.length > 0 && result.rows[0].floor_price) {
      // Update floor price
      await pool.query(
        `
        UPDATE clubs
        SET floor_price_wei = $1,
            floor_price_currency = $2,
            last_floor_update = NOW()
        WHERE name = $3
        `,
        [result.rows[0].floor_price.toString(), result.rows[0].currency_address, clubName]
      );

      logger.info(
        { clubName, floorPrice: result.rows[0].floor_price.toString() },
        'Updated club floor price'
      );
    } else {
      // No active listings - clear floor price
      await pool.query(
        `
        UPDATE clubs
        SET floor_price_wei = NULL,
            floor_price_currency = NULL,
            last_floor_update = NOW()
        WHERE name = $1
        `,
        [clubName]
      );

      logger.info({ clubName }, 'Cleared club floor price (no active listings)');
    }
  } catch (error) {
    logger.error({ error, clubName }, 'Error recalculating floor price');
    throw error;
  }
}

/**
 * Update floor price if new price is lower than current floor
 */
async function updateFloorIfLower(clubName: string, newPrice: string): Promise<void> {
  try {
    const result = await pool.query(
      `
      SELECT floor_price_wei
      FROM clubs
      WHERE name = $1
      `,
      [clubName]
    );

    if (result.rows.length === 0) return;

    const currentFloor = result.rows[0].floor_price_wei;
    const newPriceNum = BigInt(newPrice);

    // If no floor exists OR new price is lower, update
    if (!currentFloor || newPriceNum < BigInt(currentFloor)) {
      await pool.query(
        `
        UPDATE clubs
        SET floor_price_wei = $1,
            floor_price_currency = '0x0000000000000000000000000000000000000000',
            last_floor_update = NOW()
        WHERE name = $2
        `,
        [newPrice, clubName]
      );

      logger.info(
        { clubName, oldFloor: currentFloor, newFloor: newPrice },
        'Updated club floor price (new low)'
      );
    }
  } catch (error) {
    logger.error({ error, clubName, newPrice }, 'Error updating floor price');
    throw error;
  }
}

/**
 * Recalculate sales statistics for a club from scratch
 */
async function recalculateSalesStats(clubName: string): Promise<void> {
  logger.info({ clubName }, 'Recalculating sales stats for club');

  try {
    // Calculate total sales count and volume (ETH and WETH)
    const result = await pool.query(
      `
      SELECT COUNT(*) as sales_count,
             COALESCE(SUM(s.sale_price_wei::numeric), 0) as total_volume
      FROM sales s
      JOIN ens_names e ON s.ens_name_id = e.id
      WHERE $1 = ANY(e.clubs)
        AND ${ETH_WETH_FILTER}
      `,
      [clubName]
    );

    const salesCount = parseInt(result.rows[0].sales_count) || 0;
    const totalVolume = result.rows[0].total_volume?.toString() || '0';

    await pool.query(
      `
      UPDATE clubs
      SET total_sales_count = $1,
          total_sales_volume_wei = $2,
          last_sales_update = NOW()
      WHERE name = $3
      `,
      [salesCount, totalVolume, clubName]
    );

    logger.info(
      { clubName, salesCount, totalVolume },
      'Updated club sales statistics'
    );
  } catch (error) {
    logger.error({ error, clubName }, 'Error recalculating sales stats');
    throw error;
  }
}

export async function registerClubStatsWorker(boss: PgBoss): Promise<void> {
  // Worker 1: Update floor price (optimized - only when needed)
  await boss.work<UpdateClubFloorPriceJob>(
    'update-club-floor-price',
    {
      teamSize: 3,
      teamConcurrency: 2,
    },
    async (job) => {
      const { clubNames, eventType, listingPrice } = job.data;

      logger.info(
        { clubNames, eventType, listingPrice },
        'Processing club floor price update'
      );

      for (const clubName of clubNames) {
        try {
          if (eventType === 'delete') {
            // Listing was deleted/cancelled/sold - need to recalculate
            // in case it was the floor listing
            await recalculateFloorPrice(clubName);
          } else if (listingPrice) {
            // New listing or price update - check if it's a new low
            await updateFloorIfLower(clubName, listingPrice);
          }
        } catch (error) {
          logger.error({ error, clubName, eventType }, 'Failed to update club floor price');
          throw error; // Will be retried by pg-boss
        }
      }
    }
  );

  // Worker 2: Update sales stats (simple increment)
  await boss.work<UpdateClubSalesStatsJob>(
    'update-club-sales-stats',
    {
      teamSize: 5,
      teamConcurrency: 3,
    },
    async (job) => {
      const { clubNames, salePriceWei } = job.data;

      logger.info(
        { clubNames, salePriceWei },
        'Processing club sales stats update'
      );

      try {
        // Increment sales count and add to volume for all clubs
        await pool.query(
          `
          UPDATE clubs
          SET total_sales_count = total_sales_count + 1,
              total_sales_volume_wei = (COALESCE(total_sales_volume_wei::numeric, 0) + $1::numeric)::text,
              last_sales_update = NOW()
          WHERE name = ANY($2)
          `,
          [salePriceWei, clubNames]
        );

        logger.info({ clubNames, salePriceWei }, 'Updated club sales statistics');
      } catch (error) {
        logger.error({ error, clubNames, salePriceWei }, 'Failed to update club sales stats');
        throw error; // Will be retried by pg-boss
      }
    }
  );

  // Worker 3: Full recalculation (for corrections/initial setup)
  await boss.work<RecalculateClubStatsJob>(
    'recalculate-club-stats',
    {
      teamSize: 2,
      teamConcurrency: 1,
    },
    async (job) => {
      const { clubName } = job.data;

      logger.info({ clubName }, 'Recalculating all stats for club');

      try {
        await recalculateFloorPrice(clubName);
        await recalculateSalesStats(clubName);

        logger.info({ clubName }, 'Successfully recalculated all club stats');
      } catch (error) {
        logger.error({ error, clubName }, 'Failed to recalculate club stats');
        throw error; // Will be retried by pg-boss
      }
    }
  );

  logger.info('Club stats workers registered');
}
