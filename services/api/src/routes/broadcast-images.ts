import type { FastifyInstance } from 'fastify';
import { getFile, isStorageEnabled } from '../../../shared/src';

const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const IMAGE_CACHE_MAX = 120;
interface CachedImage {
  body: Buffer;
  contentType: string;
  cachedAt: number;
}
const imageCache = new Map<string, CachedImage>();

function evictStaleImages() {
  const now = Date.now();
  for (const [key, entry] of imageCache) {
    if (now - entry.cachedAt > IMAGE_CACHE_TTL_MS) imageCache.delete(key);
  }
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of imageCache) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) imageCache.delete(oldestKey);
  }
}

// Keys must live under broadcasts/ and contain only safe characters — this
// route serves any key we're asked for, so restrict the namespace.
const SAFE_KEY_RE = /^broadcasts\/[A-Za-z0-9._\-/]+$/;

export async function broadcastImagesRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
    const key = (request.params as { '*': string })['*'];
    if (!key || !SAFE_KEY_RE.test(`broadcasts/${key}`)) {
      return reply.status(400).send({ success: false, error: 'Invalid image key' });
    }

    const fullKey = `broadcasts/${key}`;

    const cached = imageCache.get(fullKey);
    if (cached && Date.now() - cached.cachedAt < IMAGE_CACHE_TTL_MS) {
      return reply
        .header('Content-Type', cached.contentType)
        .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
        .send(cached.body);
    }

    if (!isStorageEnabled()) {
      return reply.status(503).send({ success: false, error: 'Storage not configured' });
    }

    try {
      const file = await getFile(fullKey);
      if (!file) {
        return reply.status(404).send({ success: false, error: 'Image not found' });
      }

      evictStaleImages();
      imageCache.set(fullKey, { body: file.body, contentType: file.contentType, cachedAt: Date.now() });

      return reply
        .header('Content-Type', file.contentType)
        .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
        .send(file.body);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: 'Failed to serve image' });
    }
  });
}
