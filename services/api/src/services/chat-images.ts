import { randomUUID } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { getPostgresPool, deleteFile, isStorageEnabled } from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * Shared helpers for chat image attachments: upload parsing/validation, storage
 * key + serving-URL construction, and the SQL fragment / post-processor that
 * embeds an `attachment` object in serialized messages.
 *
 * Bucket I/O itself uses the shared storage client (uploadFile/deleteFile/getFile).
 */

// Bucket key namespace for chat images, e.g. "chat/<chatId>/<uuid>.jpg". The
// serving route (chat-images.ts) strips this prefix from the request path.
export const CHAT_IMAGE_KEY_PREFIX = 'chat';

// Max upload size PER IMAGE. Overridable via env so ops can tune without a
// redeploy of the constant; default 10 MB.
export const MAX_IMAGE_BYTES =
  parseInt(process.env.CHAT_IMAGE_MAX_BYTES || '', 10) || 10 * 1024 * 1024;

// Max images allowed in a single message. Overridable via env; default 5.
export const MAX_IMAGES_PER_MESSAGE =
  parseInt(process.env.CHAT_MAX_IMAGES_PER_MESSAGE || '', 10) || 5;

// Allowed image MIME types → file extension used in the storage key.
export const ALLOWED_IMAGE_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Detect an allowed image type from a buffer's magic bytes, returning the MIME
 * string or null. Trusting the client's multipart Content-Type is unsafe — it's
 * attacker-controlled — so we sniff the real bytes instead of relying on a
 * heavier dependency like `file-type` (which is ESM-only and awkward in this
 * CommonJS build). Covers exactly the four formats we accept.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // GIF: "GIF87a" or "GIF89a"
  if (
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * SQL fragment selecting a message's attachments as a JSON array (empty when
 * none) for a message aliased `m`, ordered by `position`. Each element carries
 * `storage_key` (not a URL) — call withAttachmentUrls() on the row to turn each
 * into a public `url`.
 */
export const ATTACHMENTS_SELECT = `(
           SELECT COALESCE(
                    json_agg(
                      json_build_object(
                        'storage_key', a.storage_key,
                        'content_type', a.content_type,
                        'width', a.width,
                        'height', a.height,
                        'byte_size', a.byte_size,
                        'expired', a.expired_at IS NOT NULL
                      ) ORDER BY a.position, a.created_at
                    ),
                    '[]'::json
                  )
             FROM message_attachments a
            WHERE a.message_id = m.id
         ) AS attachments`;

/** Build the public serving URL for a stored chat image key. */
export function chatImageUrl(storageKey: string): string {
  const rel = storageKey.startsWith(`${CHAT_IMAGE_KEY_PREFIX}/`)
    ? storageKey.slice(CHAT_IMAGE_KEY_PREFIX.length + 1)
    : storageKey;
  return `/api/v1/chats/images/${rel}`;
}

/** Generate a fresh unguessable storage key for a chat image. */
export function buildChatImageKey(chatId: string, ext: string): string {
  return `${CHAT_IMAGE_KEY_PREFIX}/${chatId}/${randomUUID()}.${ext}`;
}

/**
 * Replace each raw attachment in a serialized message's `attachments` array
 * (carrying `storage_key`) with a client-facing shape carrying a `url` instead.
 * No-op when there are no attachments. Mutates and returns the same object for
 * convenient use inside `.map()`.
 */
export function withAttachmentUrls<T extends { attachments?: any }>(message: T): T {
  const arr = message.attachments;
  if (Array.isArray(arr)) {
    (message as any).attachments = arr.map((a: any) => {
      if (a && typeof a === 'object' && a.storage_key) {
        const { storage_key, ...rest } = a;
        return { ...rest, url: chatImageUrl(storage_key) };
      }
      return a;
    });
  }
  return message;
}

export interface ParsedImageFile {
  buffer: Buffer;
  mimetype: string;
  ext: string;
}

export interface ParsedImageUpload {
  /** One entry per uploaded image, in client order (1..MAX_IMAGES_PER_MESSAGE). */
  files: ParsedImageFile[];
  /** Non-file form fields (e.g. body/caption, reply_to_message_id). */
  fields: Record<string, string>;
}

export type ParseImageError =
  | 'NO_FILE'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_IMAGES'
  | 'UNSUPPORTED_TYPE';

/**
 * Parse a multipart request carrying up to MAX_IMAGES_PER_MESSAGE image files
 * (repeated `file` parts) plus optional text fields. Collects parts in document
 * order, so text fields may appear before, between, or after the files, and the
 * files keep their upload order. Returns a discriminated result; never throws on
 * the expected validation failures.
 */
export async function parseImageUpload(
  request: FastifyRequest
): Promise<ParsedImageUpload | { error: ParseImageError }> {
  const buffers: Buffer[] = [];
  const fields: Record<string, string> = {};

  const parts = request.parts({
    limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_MESSAGE },
  });
  try {
    for await (const part of parts) {
      if (part.type === 'file') {
        // toBuffer() throws FST_REQ_FILE_TOO_LARGE if the per-file size limit is
        // breached; exceeding the files count throws FST_FILES_LIMIT. Both are
        // handled by the catch below — the stream `truncated` flag is only set
        // when consuming the stream manually, so there's no separate check here.
        buffers.push(await part.toBuffer());
      } else {
        fields[part.fieldname] = String((part as any).value ?? '');
      }
    }
  } catch (err: any) {
    if (err?.code === 'FST_FILES_LIMIT') {
      return { error: 'TOO_MANY_IMAGES' };
    }
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
      return { error: 'FILE_TOO_LARGE' };
    }
    throw err;
  }

  if (buffers.length === 0) return { error: 'NO_FILE' };

  // Validate each file against its actual magic bytes, NOT the client-declared
  // Content-Type (which is fully attacker-controlled). The sniffed type is
  // authoritative for both the stored content_type and the key extension. If any
  // file fails, reject the whole upload (the caller uploads nothing).
  const files: ParsedImageFile[] = [];
  for (const buffer of buffers) {
    const mimetype = sniffImageMime(buffer);
    const ext = mimetype ? ALLOWED_IMAGE_MIME[mimetype] : undefined;
    if (!mimetype || !ext) return { error: 'UNSUPPORTED_TYPE' };
    files.push({ buffer, mimetype, ext });
  }

  return { files, fields };
}

/**
 * Pull the bucket objects for the given messages and stamp `expired_at` on the
 * rows we successfully removed (failed deletes stay unexpired so the
 * image-expiry worker retries them later). Best-effort: never throws.
 *
 * Called by both user self-delete and admin moderation so a deleted message's
 * image stops being served immediately, rather than lingering in the bucket
 * (and reachable via its URL) until the 180-day expiry sweep.
 */
export async function expireMessageAttachments(
  pool: ReturnType<typeof getPostgresPool>,
  messageIds: string[]
): Promise<void> {
  if (messageIds.length === 0 || !isStorageEnabled()) return;
  // Wrap the whole body: callers await this immediately before critical writes
  // (the soft-delete / moderation-log INSERT) with no try/catch of their own, so
  // a transient DB error here must NOT propagate and abort their flow. The
  // image-expiry worker is the backstop — anything still expired_at IS NULL gets
  // re-processed on the next run.
  try {
    const rows = await pool.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM message_attachments
        WHERE message_id = ANY($1::uuid[]) AND expired_at IS NULL`,
      [messageIds]
    );
    const succeeded: string[] = [];
    for (const r of rows.rows) {
      try {
        await deleteFile(r.storage_key);
        succeeded.push(r.id);
      } catch {
        // leave expired_at NULL so the image-expiry worker retries later
      }
    }
    if (succeeded.length > 0) {
      await pool.query(
        `UPDATE message_attachments SET expired_at = NOW() WHERE id = ANY($1::uuid[])`,
        [succeeded]
      );
    }
  } catch (err) {
    logger.error({ err, messageIds }, 'expireMessageAttachments failed (non-fatal)');
  }
}
