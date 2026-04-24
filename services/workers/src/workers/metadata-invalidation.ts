import PgBoss from 'pg-boss';
import { isMetadataInvalidationConfigured } from '../../../shared/src';
import {
  QUEUE_NAMES,
  type InvalidateEnsMetadataCacheJob,
} from '../queue';
import { sendMetadataInvalidationBatch } from '../services/metadata-invalidation';
import { logger } from '../utils/logger';

interface QueueJob<T> {
  id: string;
  data: T;
}

export async function registerMetadataInvalidationWorker(
  boss: PgBoss,
): Promise<void> {
  if (!isMetadataInvalidationConfigured()) {
    logger.info(
      'ENS metadata invalidation worker disabled; METADATA_INVALIDATION_BASE_URL or METADATA_INVALIDATION_AUTH_TOKEN missing',
    );
    return;
  }

  await boss.work(
    QUEUE_NAMES.INVALIDATE_ENS_METADATA_CACHE,
    {
      batchSize: 100,
      newJobCheckIntervalSeconds: 2,
    },
    async (jobs: QueueJob<InvalidateEnsMetadataCacheJob>[]) => {
      const items = jobs.map((job) => job.data);

      logger.info(
        { itemCount: items.length, jobCount: jobs.length },
        'Processing ENS metadata invalidation batch',
      );

      await sendMetadataInvalidationBatch(items);

      return {
        success: true,
        itemCount: items.length,
      };
    },
  );

  logger.info(
    { queue: QUEUE_NAMES.INVALIDATE_ENS_METADATA_CACHE },
    'ENS metadata invalidation worker registered',
  );
}
