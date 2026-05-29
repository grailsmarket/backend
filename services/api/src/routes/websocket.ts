import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { getPostgresPool, isEthOrWeth } from '../../../shared/src';
import { verifyToken } from '../middleware/auth';

interface WSClient {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
}

interface ChatWSClient {
  id: string;
  ws: WebSocket;
  userId: number;
  address: string;
  /** Set true after the client sends `{type:'subscribe'}`. Until then they get nothing. */
  subscribed: boolean;
}

interface ActivityWSClient {
  id: string;
  ws: WebSocket;
  addressSubscriptions: Set<string>; // Set of addresses to watch
  nameSubscriptions: Set<string>;     // Set of ENS names to watch
  subscribeAll: boolean;              // Subscribe to all activity
  clubSubscription: string | null;    // Single club subscription (replaces previous)
  eventTypeFilters: {
    include?: Set<string>;            // If set, only include these event types
    exclude?: Set<string>;            // If set, exclude these event types
  };
  platformFilters: {
    include?: Set<string>;            // If set, only include these platforms
    exclude?: Set<string>;            // If set, exclude these platforms
  };
  userId: number | null;             // Authenticated user id (from ?token=), required for watchlist filter
  priceFilter: { minWei?: bigint; maxWei?: bigint }; // ETH/WETH price threshold (wei)
  watchlistFilter: { active: boolean; ensNameIds: Set<number> }; // Restrict to watchlisted names
}

const clients = new Map<string, WSClient>();
const activityClients = new Map<string, ActivityWSClient>();
const chatClients = new Map<string, ChatWSClient>();

// Server-side typing-event throttle: drop bursts faster than ~5/sec per (user, chat).
const typingThrottle = new Map<string, number>();
const TYPING_MIN_INTERVAL_MS = 200;

// Track broadcast stats for debugging
let broadcastStats = {
  totalBroadcasts: 0,
  lastBroadcastTime: null as Date | null,
  lastEventType: null as string | null,
};

export function getWebSocketStats() {
  return {
    eventsClients: clients.size,
    activityClients: activityClients.size,
    activityClientDetails: Array.from(activityClients.values()).map(c => ({
      id: c.id,
      subscribeAll: c.subscribeAll,
      addressSubscriptions: Array.from(c.addressSubscriptions),
      nameSubscriptions: Array.from(c.nameSubscriptions),
      clubSubscription: c.clubSubscription,
      eventTypeFilters: {
        include: c.eventTypeFilters.include ? Array.from(c.eventTypeFilters.include) : null,
        exclude: c.eventTypeFilters.exclude ? Array.from(c.eventTypeFilters.exclude) : null,
      },
      platformFilters: {
        include: c.platformFilters.include ? Array.from(c.platformFilters.include) : null,
        exclude: c.platformFilters.exclude ? Array.from(c.platformFilters.exclude) : null,
      },
    })),
    chatClients: chatClients.size,
    chatClientDetails: Array.from(chatClients.values()).map(c => ({
      id: c.id,
      userId: c.userId,
      subscribed: c.subscribed,
    })),
    broadcastStats,
  };
}

export async function websocketRoutes(fastify: FastifyInstance) {
  // Status endpoint for debugging WebSocket connections
  fastify.get('/status', async (request, reply) => {
    return reply.send({
      success: true,
      data: getWebSocketStats(),
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  });
  fastify.get('/events', { websocket: true }, (connection, req) => {
    const clientId = req.id;
    const client: WSClient = {
      id: clientId,
      ws: connection.socket as WebSocket,
      subscriptions: new Set(),
    };

    clients.set(clientId, client);

    connection.socket.send(JSON.stringify({
      type: 'connected',
      clientId,
      timestamp: new Date().toISOString(),
    }));

    connection.socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        handleMessage(client, data);
      } catch (error) {
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    });

    connection.socket.on('close', () => {
      clients.delete(clientId);
    });

    connection.socket.on('error', (error) => {
      req.log.error({ error }, 'WebSocket error');
      clients.delete(clientId);
    });
  });

  fastify.get('/orders', { websocket: true }, (connection, req) => {
    const clientId = req.id;

    connection.socket.send(JSON.stringify({
      type: 'connected',
      channel: 'orders',
      clientId,
      timestamp: new Date().toISOString(),
    }));

    connection.socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'subscribe') {
          connection.socket.send(JSON.stringify({
            type: 'subscribed',
            orderId: data.orderId,
            timestamp: new Date().toISOString(),
          }));
        }
      } catch (error) {
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    });

    connection.socket.on('close', () => {
      req.log.info(`WebSocket closed: ${clientId}`);
    });
  });

  fastify.get('/chats', { websocket: true }, async (connection, req) => {
    const clientId = req.id;

    // Auth via ?token=... query param (browser WS APIs cannot set Authorization header)
    const token = (req.query as { token?: string })?.token;
    if (!token) {
      connection.socket.send(JSON.stringify({ type: 'error', message: 'Missing token' }));
      connection.socket.close(4401, 'Unauthorized');
      return;
    }

    let userId: number;
    let address: string;
    try {
      const decoded = verifyToken(token);
      userId = parseInt(decoded.sub, 10);
      address = decoded.address;
    } catch {
      connection.socket.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
      connection.socket.close(4401, 'Unauthorized');
      return;
    }

    const client: ChatWSClient = {
      id: clientId,
      ws: connection.socket as WebSocket,
      userId,
      address,
      subscribed: false,
    };
    chatClients.set(clientId, client);
    console.log(`[WebSocket] Chat client connected: ${clientId} (user ${userId}), total: ${chatClients.size}`);

    connection.socket.send(JSON.stringify({
      type: 'connected',
      channel: 'chats',
      clientId,
      userId,
      timestamp: new Date().toISOString(),
    }));

    connection.socket.on('message', (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());
        handleChatMessage(client, data).catch((err) => {
          req.log.error({ err }, 'Chat WS message handler error');
        });
      } catch {
        connection.socket.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    connection.socket.on('close', () => {
      chatClients.delete(clientId);
      // GC throttle keys for this user (cheap; only this user's keys)
      for (const key of typingThrottle.keys()) {
        if (key.startsWith(`${userId}:`)) typingThrottle.delete(key);
      }
    });

    connection.socket.on('error', (error) => {
      req.log.error({ error }, 'Chat WebSocket error');
      chatClients.delete(clientId);
    });
  });

  fastify.get('/activity', { websocket: true }, (connection, req) => {
    const clientId = req.id;

    // Optional auth: a ?token=<jwt> lets the client use the watchlist filter.
    // Connections without a token are still allowed (the watchlist filter just won't be available).
    let userId: number | null = null;
    const token = (req.query as { token?: string })?.token;
    if (token) {
      try {
        userId = parseInt(verifyToken(token).sub, 10);
      } catch {
        userId = null;
      }
    }

    const client: ActivityWSClient = {
      id: clientId,
      ws: connection.socket as WebSocket,
      addressSubscriptions: new Set(),
      nameSubscriptions: new Set(),
      subscribeAll: false,
      clubSubscription: null,
      eventTypeFilters: {},
      platformFilters: {},
      userId,
      priceFilter: {},
      watchlistFilter: { active: false, ensNameIds: new Set() },
    };

    activityClients.set(clientId, client);
    console.log(`[WebSocket] Activity client connected: ${clientId}, total clients: ${activityClients.size}`);

    connection.socket.send(JSON.stringify({
      type: 'connected',
      channel: 'activity',
      clientId,
      timestamp: new Date().toISOString(),
    }));

    connection.socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        void handleActivityMessage(client, data).catch((error) => {
          req.log.error({ error }, 'Error handling activity WS message');
        });
      } catch (error) {
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    });

    connection.socket.on('close', () => {
      activityClients.delete(clientId);
      req.log.info(`Activity WebSocket closed: ${clientId}`);
    });

    connection.socket.on('error', (error) => {
      req.log.error({ error }, 'Activity WebSocket error');
      activityClients.delete(clientId);
    });
  });
}

function handleMessage(client: WSClient, data: any) {
  switch (data.type) {
    case 'subscribe':
      if (data.event) {
        client.subscriptions.add(data.event);
        client.ws.send(JSON.stringify({
          type: 'subscribed',
          event: data.event,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'unsubscribe':
      if (data.event) {
        client.subscriptions.delete(data.event);
        client.ws.send(JSON.stringify({
          type: 'unsubscribed',
          event: data.event,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'ping':
      client.ws.send(JSON.stringify({
        type: 'pong',
        timestamp: new Date().toISOString(),
      }));
      break;

    default:
      client.ws.send(JSON.stringify({
        type: 'error',
        message: `Unknown message type: ${data.type}`,
      }));
  }
}

export function broadcastEvent(event: string, data: any) {
  clients.forEach(client => {
    if (client.subscriptions.has(event)) {
      client.ws.send(JSON.stringify({
        type: 'event',
        event,
        data,
        timestamp: new Date().toISOString(),
      }));
    }
  });
}

export function broadcastToAll(data: any) {
  clients.forEach(client => {
    client.ws.send(JSON.stringify({
      type: 'broadcast',
      data,
      timestamp: new Date().toISOString(),
    }));
  });
}

async function handleActivityMessage(client: ActivityWSClient, data: any) {
  switch (data.type) {
    case 'subscribe_all':
      client.subscribeAll = true;
      client.ws.send(JSON.stringify({
        type: 'subscribed',
        subscription_type: 'all',
        timestamp: new Date().toISOString(),
      }));
      break;

    case 'unsubscribe_all':
      client.subscribeAll = false;
      client.ws.send(JSON.stringify({
        type: 'unsubscribed',
        subscription_type: 'all',
        timestamp: new Date().toISOString(),
      }));
      break;

    case 'subscribe_address':
      if (data.address) {
        const normalizedAddress = data.address.toLowerCase();
        client.addressSubscriptions.add(normalizedAddress);
        client.ws.send(JSON.stringify({
          type: 'subscribed',
          subscription_type: 'address',
          address: normalizedAddress,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'unsubscribe_address':
      if (data.address) {
        const normalizedAddress = data.address.toLowerCase();
        client.addressSubscriptions.delete(normalizedAddress);
        client.ws.send(JSON.stringify({
          type: 'unsubscribed',
          subscription_type: 'address',
          address: normalizedAddress,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'subscribe_name':
      if (data.name) {
        client.nameSubscriptions.add(data.name);
        client.ws.send(JSON.stringify({
          type: 'subscribed',
          subscription_type: 'name',
          name: data.name,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'unsubscribe_name':
      if (data.name) {
        client.nameSubscriptions.delete(data.name);
        client.ws.send(JSON.stringify({
          type: 'unsubscribed',
          subscription_type: 'name',
          name: data.name,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'subscribe_club':
      if (data.club) {
        client.clubSubscription = data.club;
        client.ws.send(JSON.stringify({
          type: 'subscribed',
          subscription_type: 'club',
          club: data.club,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'unsubscribe_club':
      client.clubSubscription = null;
      client.ws.send(JSON.stringify({
        type: 'unsubscribed',
        subscription_type: 'club',
        timestamp: new Date().toISOString(),
      }));
      break;

    case 'set_event_filter':
      // Set event type filter - can be 'include' or 'exclude'
      if (data.filter_type && data.event_types && Array.isArray(data.event_types)) {
        if (data.filter_type === 'include') {
          client.eventTypeFilters.include = new Set(data.event_types);
          client.eventTypeFilters.exclude = undefined;
        } else if (data.filter_type === 'exclude') {
          client.eventTypeFilters.exclude = new Set(data.event_types);
          client.eventTypeFilters.include = undefined;
        }
        client.ws.send(JSON.stringify({
          type: 'filter_set',
          filter_kind: 'event_type',
          filter_type: data.filter_type,
          event_types: data.event_types,
          timestamp: new Date().toISOString(),
        }));
      } else {
        client.ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid filter format. Expected: { type: "set_event_filter", filter_type: "include"|"exclude", event_types: string[] }',
        }));
      }
      break;

    case 'clear_event_filter':
      client.eventTypeFilters = {};
      client.ws.send(JSON.stringify({
        type: 'filter_cleared',
        filter_kind: 'event_type',
        timestamp: new Date().toISOString(),
      }));
      break;

    case 'set_platform_filter':
      // Set platform filter - can be 'include' or 'exclude'
      if (data.filter_type && data.platforms && Array.isArray(data.platforms)) {
        if (data.filter_type === 'include') {
          client.platformFilters.include = new Set(data.platforms);
          client.platformFilters.exclude = undefined;
        } else if (data.filter_type === 'exclude') {
          client.platformFilters.exclude = new Set(data.platforms);
          client.platformFilters.include = undefined;
        }
        client.ws.send(JSON.stringify({
          type: 'filter_set',
          filter_kind: 'platform',
          filter_type: data.filter_type,
          platforms: data.platforms,
          timestamp: new Date().toISOString(),
        }));
      } else {
        client.ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid filter format. Expected: { type: "set_platform_filter", filter_type: "include"|"exclude", platforms: string[] }',
        }));
      }
      break;

    case 'clear_platform_filter':
      client.platformFilters = {};
      client.ws.send(JSON.stringify({
        type: 'filter_cleared',
        filter_kind: 'platform',
        timestamp: new Date().toISOString(),
      }));
      break;

    case 'set_price_filter': {
      // { type:'set_price_filter', min_price_wei?: string, max_price_wei?: string } (decimal wei strings)
      const parseWei = (v: any): bigint | undefined => {
        if (typeof v !== 'string' || !/^\d+$/.test(v)) return undefined;
        return BigInt(v);
      };
      const minWei = parseWei(data.min_price_wei);
      const maxWei = parseWei(data.max_price_wei);
      if (minWei === undefined && maxWei === undefined) {
        client.ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid price filter. Expected min_price_wei and/or max_price_wei as decimal wei strings',
        }));
        break;
      }
      client.priceFilter = { minWei, maxWei };
      client.ws.send(JSON.stringify({
        type: 'filter_set',
        filter_kind: 'price',
        min_price_wei: minWei?.toString() ?? null,
        max_price_wei: maxWei?.toString() ?? null,
        timestamp: new Date().toISOString(),
      }));
      break;
    }

    case 'clear_price_filter':
      client.priceFilter = {};
      client.ws.send(JSON.stringify({
        type: 'filter_cleared',
        filter_kind: 'price',
        timestamp: new Date().toISOString(),
      }));
      break;

    case 'set_watchlist_filter': {
      // { type:'set_watchlist_filter', list_id?: number } - requires an authenticated connection (?token=)
      // Snapshots the user's watchlisted name ids; the client re-sends this to refresh.
      if (client.userId == null) {
        client.ws.send(JSON.stringify({
          type: 'error',
          message: 'Authentication required for watchlist filter. Connect with ?token=<jwt>',
        }));
        break;
      }
      try {
        const pool = getPostgresPool();
        const listId =
          typeof data.list_id === 'number' && Number.isInteger(data.list_id) ? data.list_id : null;
        const result = listId != null
          ? await pool.query(
              'SELECT ens_name_id FROM watchlist WHERE user_id = $1 AND list_id = $2',
              [client.userId, listId]
            )
          : await pool.query(
              'SELECT ens_name_id FROM watchlist WHERE user_id = $1',
              [client.userId]
            );
        client.watchlistFilter = {
          active: true,
          ensNameIds: new Set(result.rows.map((r) => Number(r.ens_name_id))),
        };
        client.ws.send(JSON.stringify({
          type: 'filter_set',
          filter_kind: 'watchlist',
          list_id: listId,
          count: client.watchlistFilter.ensNameIds.size,
          timestamp: new Date().toISOString(),
        }));
      } catch (error) {
        console.error('Error loading watchlist for activity WS filter:', error);
        client.ws.send(JSON.stringify({
          type: 'error',
          message: 'Failed to load watchlist filter',
        }));
      }
      break;
    }

    case 'clear_watchlist_filter':
      client.watchlistFilter = { active: false, ensNameIds: new Set() };
      client.ws.send(JSON.stringify({
        type: 'filter_cleared',
        filter_kind: 'watchlist',
        timestamp: new Date().toISOString(),
      }));
      break;

    case 'ping':
      client.ws.send(JSON.stringify({
        type: 'pong',
        timestamp: new Date().toISOString(),
      }));
      break;

    default:
      client.ws.send(JSON.stringify({
        type: 'error',
        message: `Unknown message type: ${data.type}`,
      }));
  }
}

/**
 * Broadcast activity event to all subscribed clients
 * @param activityData Activity history record data
 */
export function broadcastActivityEvent(activityData: any) {
  const {
    actor_address,
    counterparty_address,
    name,
    event_type,
    ens_name_id,
    price_wei,
    currency_address,
  } = activityData;

  // Update broadcast stats
  broadcastStats.totalBroadcasts++;
  broadcastStats.lastBroadcastTime = new Date();
  broadcastStats.lastEventType = event_type;

  console.log(`[WebSocket] Broadcasting activity event: ${event_type}, clients: ${activityClients.size}`);

  activityClients.forEach(client => {
    let shouldSend = false;

    // Check if client is subscribed to all activity
    if (client.subscribeAll) {
      shouldSend = true;
    }

    // Check if client is subscribed to the actor address
    if (actor_address && client.addressSubscriptions.has(actor_address.toLowerCase())) {
      shouldSend = true;
    }

    // Check if client is subscribed to the counterparty address
    if (counterparty_address && client.addressSubscriptions.has(counterparty_address.toLowerCase())) {
      shouldSend = true;
    }

    // Check if client is subscribed to the ENS name
    if (name && client.nameSubscriptions.has(name)) {
      shouldSend = true;
    }

    // Check if client is subscribed to a club that this name belongs to
    if (client.clubSubscription && activityData.clubs?.includes(client.clubSubscription)) {
      shouldSend = true;
    }

    // Apply event type filters
    if (shouldSend && event_type) {
      // If include filter is set, only send if event_type is in the include set
      if (client.eventTypeFilters.include) {
        shouldSend = client.eventTypeFilters.include.has(event_type);
      }
      // If exclude filter is set, don't send if event_type is in the exclude set
      else if (client.eventTypeFilters.exclude) {
        shouldSend = !client.eventTypeFilters.exclude.has(event_type);
      }
    }

    // Apply platform filters
    if (shouldSend) {
      if (client.platformFilters.include) {
        shouldSend = !!activityData.platform && client.platformFilters.include.has(activityData.platform);
      } else if (client.platformFilters.exclude) {
        shouldSend = !activityData.platform || !client.platformFilters.exclude.has(activityData.platform);
      }
    }

    // Apply watchlist filter (AND): keep only events for the user's watchlisted names.
    if (shouldSend && client.watchlistFilter.active) {
      shouldSend = ens_name_id != null && client.watchlistFilter.ensNameIds.has(Number(ens_name_id));
    }

    // Apply price threshold filter (AND). No-price events always pass; priced events must be
    // ETH/WETH-denominated (null currency = ETH-denominated mint/renewal) and within range.
    if (shouldSend && (client.priceFilter.minWei !== undefined || client.priceFilter.maxWei !== undefined)) {
      if (price_wei == null || price_wei === '') {
        // always include no-price events
      } else if (!(currency_address == null || isEthOrWeth(currency_address))) {
        shouldSend = false;
      } else {
        let priceWei: bigint | null = null;
        try {
          priceWei = BigInt(price_wei);
        } catch {
          priceWei = null;
        }
        if (priceWei == null) {
          shouldSend = false;
        } else {
          if (client.priceFilter.minWei !== undefined && priceWei < client.priceFilter.minWei) shouldSend = false;
          if (client.priceFilter.maxWei !== undefined && priceWei > client.priceFilter.maxWei) shouldSend = false;
        }
      }
    }

    if (shouldSend) {
      try {
        client.ws.send(JSON.stringify({
          type: 'activity_event',
          event_type,
          data: activityData,
          timestamp: new Date().toISOString(),
        }));
      } catch (error) {
        console.error('Error sending activity event to client:', error);
      }
    }
  });
}

// ============================================================================
// Chat WS handler + broadcast helpers
// ============================================================================

async function handleChatMessage(client: ChatWSClient, data: any) {
  switch (data.type) {
    case 'subscribe':
      client.subscribed = true;
      client.ws.send(JSON.stringify({
        type: 'subscribed',
        channel: 'chats',
        timestamp: new Date().toISOString(),
      }));
      return;

    case 'unsubscribe':
      client.subscribed = false;
      client.ws.send(JSON.stringify({
        type: 'unsubscribed',
        channel: 'chats',
        timestamp: new Date().toISOString(),
      }));
      return;

    case 'typing':
    case 'stop_typing': {
      const chatId: string | undefined = data.chat_id;
      if (!chatId || typeof chatId !== 'string') {
        client.ws.send(JSON.stringify({ type: 'error', message: 'chat_id required' }));
        return;
      }

      const throttleKey = `${client.userId}:${chatId}`;
      const now = Date.now();
      const last = typingThrottle.get(throttleKey) ?? 0;
      if (now - last < TYPING_MIN_INTERVAL_MS) return;
      typingThrottle.set(throttleKey, now);

      // Look up other participants (and verify caller is a member). Cheap query.
      const pool = getPostgresPool();
      const result = await pool.query(
        `SELECT user_id FROM chat_participants WHERE chat_id = $1 AND left_at IS NULL`,
        [chatId]
      );
      const participantIds = result.rows.map((r) => r.user_id as number);
      if (!participantIds.includes(client.userId)) {
        client.ws.send(JSON.stringify({ type: 'error', message: 'Not a participant' }));
        return;
      }

      const eventType = data.type === 'typing' ? 'chat:typing' : 'chat:typing_stop';
      const payload = JSON.stringify({
        type: eventType,
        data: { chat_id: chatId, user_id: client.userId },
        timestamp: new Date().toISOString(),
      });

      chatClients.forEach((c) => {
        if (c.userId === client.userId) return;
        if (!c.subscribed) return;
        if (!participantIds.includes(c.userId)) return;
        try { c.ws.send(payload); } catch { /* socket closed mid-send */ }
      });
      return;
    }

    case 'ping':
      client.ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      return;

    default:
      client.ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${data.type}` }));
  }
}

interface ChatMessageRecord {
  id: string;
  chat_id: string;
  sender_user_id: number;
  body: string;
  content_type: string;
  metadata: unknown;
  created_at: string | Date;
  edited_at: string | Date | null;
  deleted_at: string | Date | null;
  sender_address?: string;
}

/** Send a JSON event to every connected, subscribed chat client whose userId is in `participantUserIds`. */
function fanOutToParticipants(participantUserIds: number[], payload: object) {
  const json = JSON.stringify(payload);
  chatClients.forEach((c) => {
    if (!c.subscribed) return;
    if (!participantUserIds.includes(c.userId)) return;
    try { c.ws.send(json); } catch { /* socket closed mid-send */ }
  });
}

export function broadcastChatEvent(args: {
  message: ChatMessageRecord;
  participantUserIds: number[];
}) {
  fanOutToParticipants(args.participantUserIds, {
    type: 'chat:message_new',
    data: { chat_id: args.message.chat_id, message: args.message },
    timestamp: new Date().toISOString(),
  });
}

export function broadcastChatReadEvent(args: {
  chatId: string;
  userId: number;
  lastReadMessageId: string;
  participantUserIds: number[];
}) {
  fanOutToParticipants(args.participantUserIds, {
    type: 'chat:read',
    data: {
      chat_id: args.chatId,
      user_id: args.userId,
      last_read_message_id: args.lastReadMessageId,
    },
    timestamp: new Date().toISOString(),
  });
}

export function broadcastChatDeletedEvent(args: {
  chatId: string;
  messageId: string;
  participantUserIds: number[];
}) {
  fanOutToParticipants(args.participantUserIds, {
    type: 'chat:message_deleted',
    data: { chat_id: args.chatId, message_id: args.messageId },
    timestamp: new Date().toISOString(),
  });
}

export function broadcastChatCreatedEvent(args: {
  chat: unknown;
  participantUserIds: number[];
}) {
  fanOutToParticipants(args.participantUserIds, {
    type: 'chat:created',
    data: { chat: args.chat },
    timestamp: new Date().toISOString(),
  });
}