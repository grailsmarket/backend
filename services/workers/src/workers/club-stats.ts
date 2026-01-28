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
    // Excludes: expired names, placeholder names, subnames
    const result = await pool.query(
      `
      SELECT MIN(l.price_wei::numeric) as floor_price,
             l.currency_address
      FROM listings l
      JOIN ens_names e ON l.ens_name_id = e.id
      WHERE l.status = 'active'
        AND $1 = ANY(e.clubs)
        AND ${ETH_WETH_FILTER}
        AND e.name NOT LIKE 'token-%'
        AND e.name NOT LIKE '%.%.eth'
        AND (e.expiry_date IS NULL OR e.expiry_date > NOW())
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
 * Calculates all-time stats and time-based windows (1y, 1mo, 1w)
 */
async function recalculateSalesStats(clubName: string): Promise<void> {
  logger.info({ clubName }, 'Recalculating sales stats for club');

  try {
    // Calculate all timeframes in a single query using FILTER clause
    const result = await pool.query(
      `
      WITH club_sales AS (
        SELECT
          s.sale_price_wei::numeric as price,
          s.sale_date
        FROM sales s
        JOIN ens_names e ON s.ens_name_id = e.id
        WHERE $1 = ANY(e.clubs)
          AND ${ETH_WETH_FILTER}
      )
      SELECT
        -- All time
        COUNT(*) as sales_count,
        COALESCE(SUM(price), 0) as total_volume,
        -- 1 year (365 days)
        COUNT(*) FILTER (WHERE sale_date > NOW() - INTERVAL '365 days') as sales_count_1y,
        COALESCE(SUM(price) FILTER (WHERE sale_date > NOW() - INTERVAL '365 days'), 0) as volume_1y,
        -- 1 month (30 days)
        COUNT(*) FILTER (WHERE sale_date > NOW() - INTERVAL '30 days') as sales_count_1mo,
        COALESCE(SUM(price) FILTER (WHERE sale_date > NOW() - INTERVAL '30 days'), 0) as volume_1mo,
        -- 1 week (7 days)
        COUNT(*) FILTER (WHERE sale_date > NOW() - INTERVAL '7 days') as sales_count_1w,
        COALESCE(SUM(price) FILTER (WHERE sale_date > NOW() - INTERVAL '7 days'), 0) as volume_1w
      FROM club_sales
      `,
      [clubName]
    );

    const row = result.rows[0];

    await pool.query(
      `
      UPDATE clubs
      SET total_sales_count = $1,
          total_sales_volume_wei = $2,
          sales_count_1y = $3,
          sales_volume_wei_1y = $4,
          sales_count_1mo = $5,
          sales_volume_wei_1mo = $6,
          sales_count_1w = $7,
          sales_volume_wei_1w = $8,
          last_sales_update = NOW()
      WHERE name = $9
      `,
      [
        parseInt(row.sales_count) || 0,
        row.total_volume?.toString() || '0',
        parseInt(row.sales_count_1y) || 0,
        row.volume_1y?.toString() || '0',
        parseInt(row.sales_count_1mo) || 0,
        row.volume_1mo?.toString() || '0',
        parseInt(row.sales_count_1w) || 0,
        row.volume_1w?.toString() || '0',
        clubName
      ]
    );

    logger.info(
      {
        clubName,
        salesCount: row.sales_count,
        totalVolume: row.total_volume?.toString(),
        salesCount1y: row.sales_count_1y,
        salesCount1mo: row.sales_count_1mo,
        salesCount1w: row.sales_count_1w
      },
      'Updated club sales statistics'
    );
  } catch (error) {
    logger.error({ error, clubName }, 'Error recalculating sales stats');
    throw error;
  }
}

/**
 * Recalculate status counts for all clubs
 * - registered_count: Names with expiry_date > NOW() (not expired)
 * - grace_count: Names with expiry_date <= NOW() AND > NOW() - 90 days (in grace period)
 * - premium_count: Names expired 90-111 days ago (in premium auction period)
 * - available_count: Names expired > 111 days ago (fully available for registration)
 * - listings_count: Names with active listings
 * This is done as a bulk update for efficiency since all clubs are updated together
 */
async function recalculateStatusCounts(): Promise<void> {
  logger.info('Recalculating status counts for all clubs');

  try {
    // Calculate status counts for all clubs in a single query using unnest
    await pool.query(
      `
      WITH status_counts AS (
        SELECT
          unnest(clubs) as club_name,
          COUNT(*) FILTER (
            WHERE expiry_date > NOW()
          ) as registered,
          COUNT(*) FILTER (
            WHERE expiry_date <= NOW()
              AND expiry_date > NOW() - INTERVAL '90 days'
          ) as grace,
          COUNT(*) FILTER (
            WHERE expiry_date <= NOW() - INTERVAL '90 days'
              AND expiry_date > NOW() - INTERVAL '111 days'
          ) as premium,
          COUNT(*) FILTER (
            WHERE expiry_date <= NOW() - INTERVAL '111 days'
          ) as available
        FROM ens_names
        WHERE clubs IS NOT NULL AND array_length(clubs, 1) > 0
        GROUP BY unnest(clubs)
      )
      UPDATE clubs c
      SET registered_count = COALESCE(sc.registered, 0),
          grace_count = COALESCE(sc.grace, 0),
          premium_count = COALESCE(sc.premium, 0),
          available_count = COALESCE(sc.available, 0)
      FROM status_counts sc
      WHERE c.name = sc.club_name
      `
    );

    // Calculate listings counts separately (requires join with listings table)
    await pool.query(
      `
      WITH listings_counts AS (
        SELECT
          unnest(en.clubs) as club_name,
          COUNT(*) as listings
        FROM listings l
        JOIN ens_names en ON l.ens_name_id = en.id
        WHERE l.status = 'active'
          AND en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0
        GROUP BY unnest(en.clubs)
      )
      UPDATE clubs c
      SET listings_count = COALESCE(lc.listings, 0)
      FROM listings_counts lc
      WHERE c.name = lc.club_name
      `
    );

    // Set listings_count to 0 for clubs with no active listings
    await pool.query(
      `
      UPDATE clubs
      SET listings_count = 0
      WHERE name NOT IN (
        SELECT DISTINCT unnest(en.clubs)
        FROM listings l
        JOIN ens_names en ON l.ens_name_id = en.id
        WHERE l.status = 'active'
          AND en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0
      )
      `
    );

    // Set status counts to 0 for clubs with no names
    await pool.query(
      `
      UPDATE clubs
      SET registered_count = 0,
          grace_count = 0,
          premium_count = 0,
          available_count = 0
      WHERE name NOT IN (
        SELECT DISTINCT unnest(clubs)
        FROM ens_names
        WHERE clubs IS NOT NULL AND array_length(clubs, 1) > 0
      )
      `
    );

    logger.info('Successfully recalculated status counts for all clubs');
  } catch (error) {
    logger.error({ error }, 'Error recalculating status counts');
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

  // Worker 2: Update sales stats (increment all time windows)
  // New sales are always within all time windows (1w, 1mo, 1y, all-time)
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
        // Increment all time windows (new sale is within all windows)
        await pool.query(
          `
          UPDATE clubs
          SET total_sales_count = total_sales_count + 1,
              total_sales_volume_wei = (COALESCE(total_sales_volume_wei::numeric, 0) + $1::numeric)::text,
              sales_count_1y = sales_count_1y + 1,
              sales_volume_wei_1y = (COALESCE(sales_volume_wei_1y::numeric, 0) + $1::numeric)::text,
              sales_count_1mo = sales_count_1mo + 1,
              sales_volume_wei_1mo = (COALESCE(sales_volume_wei_1mo::numeric, 0) + $1::numeric)::text,
              sales_count_1w = sales_count_1w + 1,
              sales_volume_wei_1w = (COALESCE(sales_volume_wei_1w::numeric, 0) + $1::numeric)::text,
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

  // Scheduled job: Hourly recalculation of all club stats
  // This handles "rolling window decay" as old sales fall outside time windows
  await boss.schedule('recalculate-all-club-stats', '0 * * * *', {});

  // Worker 4: Process hourly recalculation schedule
  await boss.work(
    'recalculate-all-club-stats',
    {
      teamSize: 1,
      teamConcurrency: 1,
    },
    async () => {
      logger.info('Starting scheduled club stats recalculation');

      try {
        // First, recalculate premium/available counts for all clubs (bulk operation)
        await recalculateStatusCounts();

        // Then queue individual club jobs for floor/sales recalculation
        const result = await pool.query('SELECT name FROM clubs ORDER BY name');
        const clubs = result.rows;

        for (const club of clubs) {
          await boss.send('recalculate-club-stats', { clubName: club.name });
        }

        logger.info(
          { clubCount: clubs.length },
          'Queued all clubs for stats recalculation'
        );
      } catch (error) {
        logger.error({ error }, 'Failed to queue club stats recalculation');
        throw error;
      }
    }
  );

  logger.info('Club stats workers registered');
}
