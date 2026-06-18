import { Client } from 'pg';
import { getPostgresPool, config } from '../../../shared/src';
import { broadcastChatEvent, broadcastGlobalChatEvent } from '../routes/websocket';
import { GLOBAL_CHAT_ID } from './global-chat';
import { REPLY_TO_PREVIEW_SELECT, REPLY_TO_JOINS } from './chat-notifications';
import { ATTACHMENT_SELECT, withAttachmentUrl } from './chat-images';

/**
 * Listens for `chat_message_created` PG notifications (emitted by the AFTER INSERT
 * trigger on the messages table — see migration 0848) and fans the message out to
 * connected /ws/chats clients via broadcastChatEvent().
 *
 * Uses a dedicated direct DB connection (bypasses PgBouncer) so LISTEN/NOTIFY works.
 * Mirrors activity-notifier.ts.
 */
export class ChatNotifier {
  private client: Client | null = null;
  private isRunning = false;
  private pool = getPostgresPool();

  async start() {
    console.log('Starting chat notifier...');
    this.isRunning = true;

    const connectionString = process.env.DATABASE_DIRECT_URL || config.database.url;
    const usingDirect = !!process.env.DATABASE_DIRECT_URL;

    this.client = new Client({
      connectionString,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    });

    await this.client.connect();
    console.log(`[ChatNotifier] Connected using ${usingDirect ? 'direct' : 'pooled'} connection`);

    await this.client.query('LISTEN chat_message_created');

    this.client.on('notification', async (msg) => {
      if (msg.channel !== 'chat_message_created') return;
      try {
        const payload = JSON.parse(msg.payload || '{}');
        if (payload.message_id) {
          await this.handleMessageCreated(payload.message_id);
        }
      } catch (error) {
        console.error('Error processing chat_message_created notification:', error);
      }
    });

    this.client.on('error', (error) => {
      console.error('Chat notifier client error:', error);
      this.reconnect();
    });

    console.log('Chat notifier started successfully');
  }

  async stop() {
    console.log('Stopping chat notifier...');
    this.isRunning = false;
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  private async reconnect() {
    console.log('Reconnecting chat notifier...');
    await this.stop();
    if (this.isRunning) {
      setTimeout(() => {
        this.start().catch(console.error);
      }, 5000);
    }
  }

  private async handleMessageCreated(messageId: string) {
    try {
      // Fetch the message + sender address + participant ids in one round-trip.
      // Identity (primary name/avatar) is resolved client-side per address.
      const result = await this.pool.query(
        `SELECT
           m.id, m.chat_id, m.sender_user_id, m.body, m.content_type,
           m.metadata, m.created_at, m.edited_at, m.deleted_at,
           u.address AS sender_address,${REPLY_TO_PREVIEW_SELECT},
           ${ATTACHMENT_SELECT},
           (
             SELECT COALESCE(array_agg(cp.user_id), ARRAY[]::int[])
               FROM chat_participants cp
              WHERE cp.chat_id = m.chat_id AND cp.left_at IS NULL
           ) AS participant_user_ids
         FROM messages m
         JOIN users u ON u.id = m.sender_user_id${REPLY_TO_JOINS}
         WHERE m.id = $1`,
        [messageId]
      );

      if (result.rows.length === 0) return;
      const row = result.rows[0];
      const participantUserIds: number[] = row.participant_user_ids ?? [];

      const { participant_user_ids: _drop, ...message } = row;
      void _drop;

      // Freshly inserted messages have no reactions; include the empty
      // aggregate so WS payloads match the REST message shape.
      message.reactions = [];
      // Turn the raw attachment (storage_key) into a client-facing { url, ... }.
      withAttachmentUrl(message);

      if (message.chat_id === GLOBAL_CHAT_ID) {
        broadcastGlobalChatEvent({ message });
        return;
      }

      broadcastChatEvent({
        message,
        participantUserIds,
      });
    } catch (error) {
      console.error('Error fetching chat message for broadcast:', error);
    }
  }
}
