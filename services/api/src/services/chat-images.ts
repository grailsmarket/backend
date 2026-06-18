import { randomUUID } from 'crypto';
import type { FastifyRequest } from 'fastify';

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

// Max upload size. Overridable via env so ops can tune without a redeploy of the
// constant; default 10 MB.
export const MAX_IMAGE_BYTES =
  parseInt(process.env.CHAT_IMAGE_MAX_BYTES || '', 10) || 10 * 1024 * 1024;

// Allowed image MIME types → file extension used in the storage key.
export const ALLOWED_IMAGE_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * SQL fragment selecting a single attachment as a JSON object (or NULL) for a
 * message aliased `m`. MVP = one image per message. Returns `storage_key` (not a
 * URL) — call withAttachmentUrl() on the row to turn it into a public `url`.
 */
export const ATTACHMENT_SELECT = `(
           SELECT json_build_object(
                    'storage_key', a.storage_key,
                    'content_type', a.content_type,
                    'width', a.width,
                    'height', a.height,
                    'byte_size', a.byte_size,
                    'expired', a.expired_at IS NOT NULL
                  )
             FROM message_attachments a
            WHERE a.message_id = m.id
            ORDER BY a.created_at
            LIMIT 1
         ) AS attachment`;

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
 * Replace a serialized message's raw `attachment` (with storage_key) with a
 * client-facing shape carrying a `url` instead. No-op when there's no image.
 * Mutates and returns the same object for convenient use inside `.map()`.
 */
export function withAttachmentUrl<T extends { attachment?: any }>(message: T): T {
  const a = message.attachment;
  if (a && typeof a === 'object' && a.storage_key) {
    const { storage_key, ...rest } = a;
    (message as any).attachment = { ...rest, url: chatImageUrl(storage_key) };
  }
  return message;
}

export interface ParsedImageUpload {
  buffer: Buffer;
  mimetype: string;
  ext: string;
  /** Non-file form fields (e.g. body/caption, reply_to_message_id). */
  fields: Record<string, string>;
}

export type ParseImageError =
  | 'NO_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE';

/**
 * Parse a multipart request carrying one image file plus optional text fields.
 * Collects parts in document order, so text fields may appear before or after
 * the file. Returns a discriminated result; never throws on the expected
 * validation failures.
 */
export async function parseImageUpload(
  request: FastifyRequest
): Promise<ParsedImageUpload | { error: ParseImageError }> {
  let buffer: Buffer | null = null;
  let mimetype = '';
  const fields: Record<string, string> = {};

  const parts = request.parts({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
  try {
    for await (const part of parts) {
      if (part.type === 'file') {
        mimetype = part.mimetype;
        const buf = await part.toBuffer();
        if ((part as any).file?.truncated) {
          return { error: 'FILE_TOO_LARGE' };
        }
        buffer = buf;
      } else {
        fields[part.fieldname] = String((part as any).value ?? '');
      }
    }
  } catch (err: any) {
    // @fastify/multipart throws when the per-file size limit is exceeded.
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE' || err?.code === 'FST_FILES_LIMIT') {
      return { error: 'FILE_TOO_LARGE' };
    }
    throw err;
  }

  if (!buffer) return { error: 'NO_FILE' };
  const ext = ALLOWED_IMAGE_MIME[mimetype];
  if (!ext) return { error: 'UNSUPPORTED_TYPE' };

  return { buffer, mimetype, ext, fields };
}
