import type { FastifyInstance } from 'fastify';
import { getFile, isStorageEnabled, getPostgresPool } from '../../../shared/src';
import { optionalAuth } from '../middleware/auth';
import { GLOBAL_CHAT_ID } from '../services/global-chat';
import { CHAT_IMAGE_KEY_PREFIX } from '../services/chat-images';

// Mirrors broadcast-images.ts: a small in-memory byte cache in front of the
// bucket. The per-request expiry + access checks run BEFORE the cache lookup, so
// caching bytes is safe (an expired or unauthorized request never reaches them).
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

// Keys must live under chat/ and contain only safe characters.
const SAFE_KEY_RE = new RegExp(`^${CHAT_IMAGE_KEY_PREFIX}/[A-Za-z0-9._\\-/]+$`);

export async function chatImagesRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  fastify.get<{ Params: { '*': string } }>('/*', { preHandler: optionalAuth }, async (request, reply) => {
    const rel = (request.params as { '*': string })['*'];
    const fullKey = `${CHAT_IMAGE_KEY_PREFIX}/${rel}`;
    if (!rel || !SAFE_KEY_RE.test(fullKey)) {
      return reply.status(400).send({ success: false, error: 'Invalid image key' });
    }

    // Resolve the attachment to enforce expiry + per-chat read access. (Unknown
    // keys 404 even if the object somehow exists in the bucket.)
    const attach = await pool.query<{ chat_id: string; expired_at: Date | null }>(
      `SELECT chat_id, expired_at FROM message_attachments WHERE storage_key = $1 LIMIT 1`,
      [fullKey]
    );
    if (attach.rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Image not found' });
    }
    const { chat_id, expired_at } = attach.rows[0];
    if (expired_at) {
      return reply.status(410).send({ success: false, error: 'Image expired' });
    }

    // Global-chat images are public; DM/group images require the caller to be a
    // participant of the owning chat (defense-in-depth — keys are unguessable).
    if (chat_id !== GLOBAL_CHAT_ID) {
      const callerId = request.user ? parseInt(request.user.sub, 10) : null;
      if (callerId === null) {
        return reply.status(401).send({ success: false, error: 'Authentication required' });
      }
      const part = await pool.query(
        `SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [chat_id, callerId]
      );
      if (part.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Image not found' });
      }
    }

    const cached = imageCache.get(fullKey);
    if (cached && Date.now() - cached.cachedAt < IMAGE_CACHE_TTL_MS) {
      return reply
        .header('Content-Type', cached.contentType)
        .header('Cache-Control', 'private, max-age=86400')
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
        .header('Cache-Control', 'private, max-age=86400')
        .send(file.body);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: 'Failed to serve image' });
    }
  });
}
