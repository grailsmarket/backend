import { config, isMetadataInvalidationConfigured } from '../../../shared/src';
import type { InvalidateEnsMetadataCacheJob } from '../queue';
import { logger } from '../utils/logger';

const RETRYABLE_STATUS_CODES = new Set([429, 502]);
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEndpoint(): string {
  const baseUrl = config.metadataInvalidation.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('METADATA_INVALIDATION_BASE_URL not configured');
  }

  return `${baseUrl}/cache/invalidate`;
}

function normalizeItem(
  item: InvalidateEnsMetadataCacheJob,
): InvalidateEnsMetadataCacheJob | null {
  const name = item.name?.trim().toLowerCase();
  const tokenId = item.tokenId?.trim();

  if (!name && !tokenId) {
    return null;
  }

  const normalized: InvalidateEnsMetadataCacheJob = {
    network: item.network,
  };

  if (name) {
    normalized.name = name;
  }

  if (tokenId) {
    normalized.tokenId = tokenId;
  }

  return normalized;
}

function getDedupeKey(item: InvalidateEnsMetadataCacheJob): string {
  if (item.name && item.tokenId) {
    return `${item.network}|name:${item.name}|token:${item.tokenId}`;
  }

  if (item.name) {
    return `${item.network}|name:${item.name}`;
  }

  return `${item.network}|token:${item.tokenId}`;
}

export function dedupeMetadataInvalidationItems(
  items: InvalidateEnsMetadataCacheJob[],
): InvalidateEnsMetadataCacheJob[] {
  const deduped = new Map<string, InvalidateEnsMetadataCacheJob>();

  for (const item of items) {
    const normalized = normalizeItem(item);
    if (!normalized) {
      continue;
    }

    deduped.set(getDedupeKey(normalized), normalized);
  }

  return [...deduped.values()];
}

export async function sendMetadataInvalidationBatch(
  items: InvalidateEnsMetadataCacheJob[],
): Promise<void> {
  if (!isMetadataInvalidationConfigured()) {
    logger.info('ENS metadata invalidation is disabled; skipping batch send');
    return;
  }

  const dedupedItems = dedupeMetadataInvalidationItems(items);
  if (dedupedItems.length === 0) {
    logger.debug('Skipping ENS metadata invalidation batch with no valid items');
    return;
  }

  const endpoint = getEndpoint();
  const authToken = config.metadataInvalidation.authToken;

  if (!authToken) {
    throw new Error('METADATA_INVALIDATION_AUTH_TOKEN not configured');
  }

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    let response: Response | null = null;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ items: dedupedItems }),
      });

      if (response.ok) {
        logger.info(
          { itemCount: dedupedItems.length, endpoint },
          'ENS metadata invalidation batch sent',
        );
        return;
      }

      const body = await response.text();
      const isRetryable = RETRYABLE_STATUS_CODES.has(response.status);
      const error = new Error(
        `metadata invalidation failed (${response.status}): ${body}`,
      ) as Error & { nonRetryable?: boolean };

      if (!isRetryable || attempt === RETRY_DELAYS_MS.length - 1) {
        if (!isRetryable) {
          error.nonRetryable = true;
        }
        throw error;
      }

      logger.warn(
        {
          attempt: attempt + 1,
          delayMs: RETRY_DELAYS_MS[attempt],
          itemCount: dedupedItems.length,
          status: response.status,
        },
        'Retrying ENS metadata invalidation batch after HTTP error',
      );
    } catch (error) {
      if ((error as { nonRetryable?: boolean }).nonRetryable) {
        throw error;
      }

      if (attempt === RETRY_DELAYS_MS.length - 1) {
        throw error;
      }

      logger.warn(
        {
          attempt: attempt + 1,
          delayMs: RETRY_DELAYS_MS[attempt],
          itemCount: dedupedItems.length,
          status: response?.status,
          err: error,
        },
        'Retrying ENS metadata invalidation batch after request failure',
      );
    }

    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}
