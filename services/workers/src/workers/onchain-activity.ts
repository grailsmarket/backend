import PgBoss from 'pg-boss';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'fetch-onchain-activity';

export async function registerOnchainActivityWorker(boss: PgBoss) {
  await boss.work(
    QUEUE_NAME,
    { teamSize: 2, teamConcurrency: 1 },
    async (job) => {
      const { address } = job.data as { address: string };
      logger.info({ jobId: job.id, address }, 'Fetching onchain activity');

      try {
        const apiKey = config.etherscan.apiKey;
        const baseUrl = config.etherscan.baseUrl;

        const url = `${baseUrl}?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=1${apiKey ? `&apikey=${apiKey}` : ''}`;
        const response = await fetch(url);
        const data = await response.json() as any;

        let lastTxAt: Date | null = null;
        let lastTxHash: string | null = null;

        if (data.status === '1' && data.result?.length > 0) {
          const tx = data.result[0];
          lastTxAt = new Date(parseInt(tx.timeStamp) * 1000);
          lastTxHash = tx.hash;
        } else {
          logger.warn(
            { jobId: job.id, address, etherscanStatus: data.status, etherscanMessage: data.message, etherscanResult: data.result },
            'Etherscan API returned non-success response',
          );
        }

        const pool = getPostgresPool();
        await pool.query(
          `INSERT INTO onchain_activity_cache (address, last_transaction_at, last_transaction_hash, last_checked_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (address) DO UPDATE SET
             last_transaction_at = EXCLUDED.last_transaction_at,
             last_transaction_hash = EXCLUDED.last_transaction_hash,
             last_checked_at = NOW()`,
          [address.toLowerCase(), lastTxAt, lastTxHash],
        );

        logger.info(
          { jobId: job.id, address, lastTxAt, lastTxHash },
          'Onchain activity cached',
        );

        return { success: true, lastTxAt, lastTxHash };
      } catch (error) {
        logger.error({ jobId: job.id, address, err: error }, 'Failed to fetch onchain activity');
        throw error;
      }
    },
  );

  logger.info({ queue: QUEUE_NAME }, 'Onchain activity worker registered');
}
