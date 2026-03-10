import PgBoss from 'pg-boss';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'check-bulk-offer-exposure';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const wethAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

/**
 * Bulk Offer Exposure Worker
 *
 * Runs every 15 minutes. For each buyer with active bulk offers:
 * - Fetches their WETH balance
 * - Sums all pending offer amounts
 * - If balance < single offer amount, marks offers as unfunded
 */
export async function registerBulkOfferExposureWorker(boss: PgBoss): Promise<void> {
  await boss.schedule(QUEUE_NAME, '*/15 * * * *');

  await boss.work(QUEUE_NAME, async () => {
    logger.info('Running bulk offer exposure check');

    const pool = getPostgresPool();
    const client = createPublicClient({
      chain: mainnet,
      transport: http(config.blockchain.rpcUrl),
    });

    try {
      // Find all buyers with active bulk offers
      const buyersResult = await pool.query(
        `SELECT DISTINCT buyer_address,
                COUNT(*) as offer_count,
                SUM(offer_amount_wei::numeric) as total_exposure
         FROM offers
         WHERE status = 'pending'
           AND offer_type IN ('bulk', 'criteria')
         GROUP BY buyer_address`
      );

      if (buyersResult.rows.length === 0) {
        logger.debug('No active bulk/criteria offers to check');
        return;
      }

      let totalUnfunded = 0;

      for (const buyer of buyersResult.rows) {
        try {
          // Fetch WETH balance
          const balance = await client.readContract({
            address: WETH_ADDRESS,
            abi: wethAbi,
            functionName: 'balanceOf',
            args: [buyer.buyer_address as `0x${string}`],
          });

          const wethBalance = BigInt(balance);

          // Find the minimum individual offer amount from this buyer's pending offers
          const minOfferResult = await pool.query(
            `SELECT MIN(offer_amount_wei::numeric) as min_amount
             FROM offers
             WHERE LOWER(buyer_address) = LOWER($1)
               AND status = 'pending'
               AND offer_type IN ('bulk', 'criteria')`,
            [buyer.buyer_address]
          );

          const minOfferAmount = BigInt(Math.floor(minOfferResult.rows[0]?.min_amount || 0));

          // If balance is less than the smallest single offer, mark all as unfunded
          if (wethBalance < minOfferAmount) {
            const unfundedResult = await pool.query(
              `UPDATE offers SET status = 'unfunded'
               WHERE LOWER(buyer_address) = LOWER($1)
                 AND status = 'pending'
                 AND offer_type IN ('bulk', 'criteria')
               RETURNING id`,
              [buyer.buyer_address]
            );

            totalUnfunded += unfundedResult.rows.length;
            logger.info(
              {
                buyerAddress: buyer.buyer_address,
                wethBalance: wethBalance.toString(),
                minOfferAmount: minOfferAmount.toString(),
                unfundedCount: unfundedResult.rows.length,
              },
              'Marked offers as unfunded due to insufficient WETH balance'
            );
          }
        } catch (rpcError) {
          logger.error(
            { error: rpcError, buyerAddress: buyer.buyer_address },
            'Failed to check WETH balance for buyer'
          );
        }
      }

      logger.info(
        { buyersChecked: buyersResult.rows.length, totalUnfunded },
        'Bulk offer exposure check completed'
      );
    } catch (error) {
      logger.error({ error }, 'Error in bulk offer exposure check');
      throw error;
    }
  });

  logger.info('Bulk offer exposure worker registered (runs every 15 minutes)');
}
