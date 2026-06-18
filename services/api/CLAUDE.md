# API Service - CLAUDE.md

## Service Overview
The REST API service for the Grails ENS marketplace system. It provides comprehensive endpoints for ENS names, listings, offers, user management, notifications, sales history, analytics, trending data, recommendations, and integrates with OpenSea for real-time marketplace data. The service also provides WebSocket connections for real-time activity feeds.

## Technology Stack
- **Runtime**: Node.js with TypeScript
- **Framework**: Fastify (high-performance web framework)
- **Database**: PostgreSQL (shared with other services)
- **Search**: Elasticsearch (via WAL Listener sync)
- **Caching**: Redis (optional, for response caching)
- **Validation**: Zod schemas
- **Authentication**: SIWE (Sign-In With Ethereum) with JWT
- **Real-time**: WebSocket support via @fastify/websocket
- **Job Queue**: pg-boss for async job publishing

## Directory Structure
```
src/
  index.ts              # Main Fastify server entry point
  queue.ts              # pg-boss queue client for job publishing
  routes/
    index.ts            # Route registration
    auth.ts             # Authentication endpoints (SIWE)
    names.ts            # ENS name endpoints
    listings.ts         # Marketplace listing endpoints
    offers.ts           # Offer management endpoints
    orders.ts           # Seaport order management
    sales.ts            # Sales history endpoints
    watchlist.ts        # User watchlist endpoints
    notifications.ts    # User notification endpoints
    users.ts            # User profile endpoints
    profiles.ts         # Public profile lookup
    activity.ts         # Activity history endpoints
    clubs.ts            # ENS clubs endpoints
    votes.ts            # Name voting endpoints
    search.ts           # Elasticsearch search endpoints
    trending.ts         # Trending names endpoints
    analytics.ts        # Market analytics endpoints
    recommendations.ts  # Personalized recommendations
    ai-recommendations.ts # AI similar-name suggestions (cached + auth-gated generation)
    user-insights.ts    # User activity history
    cart.ts             # Shopping cart endpoints
    legends.ts          # ENS Legends endpoints
    poap.ts             # POAP claim endpoints
    verification.ts     # Email verification endpoints
    websocket.ts        # WebSocket handlers
    chats.ts            # Chat / direct messaging endpoints
    blocks.ts           # Per-user message block list endpoints
    health.ts           # Health check endpoints
  services/
    seaport.ts          # Seaport order creation/validation
    opensea.ts          # OpenSea API client
    openai.ts           # OpenAI similar-name generation service
    search.ts           # Elasticsearch query builder
    activity-notifier.ts # Real-time activity broadcasts
    chat-notifier.ts    # Real-time chat message broadcasts (LISTEN chat_message_created)
    name-views.ts       # View tracking service
    mutelist.ts         # Address filtering service
  middleware/
    auth.ts             # JWT authentication (requireAuth, optionalAuth)
    cache.ts            # Redis response caching
    error-handler.ts    # Centralized error handling
  utils/
    response-builder.ts # Search result enrichment
    redis.ts            # Redis client management
    logger.ts           # Pino logger configuration
```

## API Endpoints

All endpoints are prefixed with `/api/v1/`

### Health Check
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Basic health status |
| GET | `/health/ready` | No | Readiness check (PostgreSQL + Elasticsearch) |

### Authentication (SIWE)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/nonce` | No | Get nonce for signing (stored in nonces table) |
| POST | `/auth/verify` | No | Verify SIWE signature and get JWT token |
| POST | `/auth/logout` | Yes | Invalidate current token |
| GET | `/auth/me` | Yes | Get current authenticated user info |

### ENS Names
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/names` | Optional | List ENS names with pagination |
| GET | `/names/search` | Optional | Search ENS names with Elasticsearch |
| GET | `/names/:name` | Optional | Get specific ENS name details (tracks views) |
| GET | `/names/:name/bundle` | Optional | FE bundle: name details + offers + roles in one response (tracks views) |

### Listings
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/listings` | Optional | Get paginated listings |
| GET | `/listings/search` | Optional | Search listings with Elasticsearch |
| GET | `/listings/:name` | Optional | Get listing by ENS name |
| POST | `/listings` | Yes | Create new listing |
| PATCH | `/listings/:id` | Yes | Update listing |
| DELETE | `/listings/:id` | Yes | Cancel listing |

### Offers
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/offers` | Optional | Get offers with filters |
| GET | `/offers/:name` | Optional | Get offers for specific ENS name |
| GET | `/offers/address/:address` | Optional | Get offers by address |
| POST | `/offers` | Yes | Submit new offer |
| DELETE | `/offers/:id` | Yes | Cancel offer |

### Orders (Seaport)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/orders` | No | Save order (listing/offer) to database |
| POST | `/orders/create` | No | Create Seaport order structure |
| POST | `/orders/validate` | No | Validate Seaport order |
| GET | `/orders/:id` | No | Get order by hash or ID |
| DELETE | `/orders/:id` | No | Cancel order (mark as cancelled) |

### Watchlist (Auth Required)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/watchlist` | Yes | Get user's watchlist with pagination |
| GET | `/watchlist/search` | Yes | Search/filter watchlist with Elasticsearch |
| POST | `/watchlist` | Yes | Add ENS name to watchlist |
| PATCH | `/watchlist/:id` | Yes | Update notification preferences |
| DELETE | `/watchlist/:id` | Yes | Remove from watchlist |

### Notifications (Auth Required)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/notifications` | Yes | Get user notifications (supports unreadOnly filter) |
| GET | `/notifications/unread/count` | Yes | Get unread notification count |
| PATCH | `/notifications/:id/read` | Yes | Mark notification as read |
| PATCH | `/notifications/read-all` | Yes | Mark all notifications as read |

### Sales
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sales` | No | Get recent sales with pagination |
| GET | `/sales/name/:name` | No | Get sales history for ENS name |
| GET | `/sales/address/:address` | No | Get sales by address (buyer/seller) |

### Profiles
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/profiles/:addressOrName` | No | Get profile by address or ENS name |

### Activity
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/activity` | Optional | Global activity feed |
| GET | `/activity/:name` | Optional | Get activity history for ENS name |
| GET | `/activity/address/:address` | Optional | Get activity history for an address (actor or counterparty) |

Query params (all three routes): `page`, `limit`, `event_type`, `platform`. The global feed also accepts `club` plus these filters:

- `watchlist=true` — restrict the feed to ENS names on the caller's watchlist. **Requires auth** (send `Authorization: Bearer <jwt>`); returns 401 if `watchlist=true` without a valid token. Authenticated requests bypass the response cache.
- `list_id=<id>` — with `watchlist=true`, scope to a single watchlist list; omitted = union of all the caller's lists.
- `min_price_wei` / `max_price_wei` — decimal wei strings. An active bound requires a real, in-range, ETH/WETH-denominated price; non-ETH/WETH priced events and no-price events (e.g. pure transfers, un-enriched mints) are excluded while a bound is set.

`event_type` and `platform` accept either repeated params (`?platform=opensea&platform=grails`) or a comma-separated list (`?platform=opensea,grails`). Known `platform` values today: `grails`, `opensea`, `blockchain`, `vision`, `blur`, `looksrare`, `x2y2`, `snipezone`, `enstools`, `rotki`, `other`.

### Feed (unified)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/feed` | Optional | Unified, time-ordered stream merging activity history + comments |

Single endpoint that merges `activity_history` and `comments` into one `created_at DESC` stream via a SQL `UNION ALL` (the DB does the interleaving + pagination, so the frontend no longer multiplexes two endpoints). Offset-paginated (`page`, `limit` max 100, default 20) with exact `total`/`totalPages`.

Each result item has a `kind` (`activity` | `comment`) discriminator, name-level fields hoisted to the top (`id`, `ens_name_id`, `name`, `clubs`, `owner_address`, `created_at`), plus a nested `activity` or `comment` object with the kind-specific fields.

Filters:
- `kinds` — which streams to include: `activity`, `comment`, or `activity,comment` (default = both).
- **Shared** (apply to both streams): `owner` (address), `clubs` (comma list 1–10, or `clubs=any` for names in any club), `watchlist=true` (+ optional `list_id`). `watchlist=true` **requires auth** (401 otherwise); authed requests bypass the response cache.
- **Activity-only**: `event_type`, `platform` (multi; repeated or comma-separated), `min_price_wei` / `max_price_wei` (decimal wei; an active bound requires a real ETH/WETH-denominated price, so no-price events are excluded while filtering).
- **Auto-scope rule**: when `kinds` is omitted, setting any activity-only filter implicitly excludes comments (they can't satisfy it). An explicit `kinds` always wins; `kinds=comment` combined with an activity-only filter returns 400. `kinds=activity,comment` + an activity-only filter keeps comments (explicit opt-in).

Muted addresses (mutelist) are excluded from both streams — activity actor/counterparty and comment author.

### Clubs
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/clubs` | No | List all clubs with member counts |
| GET | `/clubs/:clubName` | No | Get club details with members |
| GET | `/clubs/:clubName/floor` | No | Get club floor price |
| GET | `/clubs/:clubName/analytics` | No | Get club analytics |

### Votes
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/votes` | Yes | Cast vote on ENS name (upvote/downvote) |
| GET | `/votes/:ensName` | Optional | Get votes for ENS name |

### Users
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users/:address/badges` | No | Get POAP badges for address |
| PATCH | `/users/me` | Yes | Update user profile (email, telegram, discord, notifications) |

### Search
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/search` | Optional | Unified search with Elasticsearch |

### Trending
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/trending/views` | Optional | Trending by view count |
| GET | `/trending/watchlist` | Optional | Trending by watchlist additions |
| GET | `/trending/votes` | Optional | Trending by voting activity |
| GET | `/trending/sales` | Optional | Trending by sales activity |
| GET | `/trending/offers` | Optional | Trending by offer activity |
| GET | `/trending/composite` | Optional | Trending by composite score |

Query parameters: `period` (24h, 7d), `limit` (1-100)

### Analytics
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/analytics/market` | No | Global market statistics |
| GET | `/analytics/clubs/:club` | No | Club-specific analytics |
| GET | `/analytics/price-trends` | No | Price trends over time |
| GET | `/analytics/volume` | No | Volume distribution by price range |
| GET | `/analytics/user/me` | Yes | Personal user analytics |

Query parameters: `period` (24h, 7d, 30d, 90d, all)

### Recommendations
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/recommendations/also-viewed` | Optional | Names collectors also viewed |
| GET | `/recommendations/similar-to-watchlist` | Yes | Based on similar watchlists |
| GET | `/recommendations/based-on-votes` | Yes | Based on voting patterns |
| GET | `/recommendations/for-you` | Yes | Personalized combined recommendations |

### AI Recommendations
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/ai-recommendations/:name` | Optional (cached) / Yes (generation) | Returns cached AI suggestions to everyone; cache misses require auth and may generate + cache new suggestions |

### User Insights (Auth Required)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/user/history/viewed` | Yes | Recently viewed names |
| GET | `/user/history/watched` | Yes | Watchlist with timestamps |
| GET | `/user/history/voted` | Yes | Names user has voted on |
| GET | `/user/history/offers` | Yes | Offers user has made |
| GET | `/user/history/purchases` | Yes | Names user has purchased |
| GET | `/user/history/sales` | Yes | Names user has sold |

### Cart
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/cart` | Yes | Get user's cart items |
| GET | `/cart/summary` | Yes | Get cart item counts by type |
| POST | `/cart` | Yes | Add single item to cart |
| POST | `/cart/bulk` | Yes | Add multiple items to cart (max 100) |
| DELETE | `/cart/:id` | Yes | Remove item from cart |
| DELETE | `/cart` | Yes | Clear cart (all or by type) |

### Legends
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/legends/:address` | No | Get legend summary for address |
| GET | `/legends/:address/details` | No | Get detailed legend mints |

### POAP
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/poap/claim` | Yes | Claim a POAP link (one per user) |
| GET | `/poap/status` | Yes | Check if user has claimed POAP |
| GET | `/poap/stats` | No | Get POAP statistics |

### Email Verification
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/verification/email` | No | Verify email with token |
| POST | `/verification/resend` | Yes | Resend verification email |

### Chats (Auth Required)
Direct (1:1) messaging in v1. Schema is group-chat-ready; group endpoints are deferred.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST   | `/chats` | Yes | Create or fetch a direct chat: `{ recipient: address \| ens }`. Idempotent via `dm_key`. 501 for `recipients.length > 1`. |
| GET    | `/chats` | Yes | Inbox: paginated, last message preview + unread count + participant list. |
| GET    | `/chats/search` | Yes | Find the caller's DMs by counterparty: `?q=<name fragment or 0x…>`. A name fragment is resolved server-side against the ENS subgraph **constrained to the caller's own peer addresses** (`name_starts_with` + `resolvedAddress_in`), so recall is complete (no global top-N truncation); `0x…` prefix-matches the peer address. Matches the peer's **resolved/chatting address** (not the name's NFT owner), reusing the inbox row shape. Capped at 50, unpaginated; <2 chars or no matches → `{ chats: [] }`. |
| GET    | `/chats/:id` | Yes | Chat detail with participants and each participant's `last_read_message_id`. |
| GET    | `/chats/:id/messages` | Yes | Cursor pagination via `?before=<message-uuid>&limit=<1-100>`. |
| POST   | `/chats/:id/messages` | Yes | Send a message: `{ body }` (1–4000 chars) + optional `reply_to_message_id` (must be a live message in the same chat, else 400 `INVALID_REPLY_TARGET`). Per-route rate limit: 30/min. Fires `chat_reply`/`chat_mention` notifications. |
| POST   | `/chats/:id/messages/image` | Yes | Send an image (multipart: `file` + optional `body` caption + optional `reply_to_message_id`). Gated by the `images_enabled` master switch (403 `IMAGES_DISABLED`). 413 `FILE_TOO_LARGE`, 400 `UNSUPPORTED_TYPE`/`NO_FILE`, 503 `STORAGE_UNAVAILABLE`. Inserts a `messages` row (`content_type='image'`) + a `message_attachments` row atomically; on failure the bucket object is cleaned up. Response message carries an `attachment: { url, content_type, width, height, byte_size, expired }`. |
| POST   | `/chats/:id/read` | Yes | Mark read: `{ up_to_message_id }`. Broadcasts `chat:read` over WS. |
| DELETE | `/chats/:id/messages/:messageId` | Yes | Soft-delete caller's own message (records `deleted_by = caller`). Also serves the global room (`:id` = global UUID) — branches WS to global subscribers. |
| PATCH  | `/chats/:id/messages/:messageId` | Yes | Edit caller's own message: `{ body }` (1–4000). Stamps `edited_at`, broadcasts `chat:message_edited`. 404 if not the sender or already deleted. Also serves the global room (enforces `max_message_length` there). |
| PATCH  | `/chats/:id` | Yes | `{ muted? }` per-chat mute. |

Self-delete and edit work for the global room through this same `:id` route (the global UUID), mirroring reactions — there are no dedicated `/chats/global/messages/:id` mutation routes. Soft-deleted messages return `body: null` plus `deleted_by_admin` (derived: `deleted_by` differs from the author ⇒ admin moderation, else author self-delete).

Send-message enforcement: caller must be a participant; nobody in the chat may have blocked the caller; all other participants must have `accept_messages = TRUE`.

`PATCH /users/me` accepts `acceptMessages: boolean` to globally opt out (hard block).

### Message Reactions (DMs + Global Chat)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET    | `/chats/:id/messages/:messageId/reactions` | Optional | Who reacted, grouped by emoji: `{ reactions: [{ emoji, count, users: [{ address }] }] }` (users oldest-first). Public for the global room; participants only for DMs (401 if unauth DM, 404 if not a participant). |
| POST   | `/chats/:id/messages/:messageId/reactions` | Yes | Add `{ emoji }` (single grapheme, ≤32 chars). Idempotent: `{ added: false }` on repeat, no broadcast. Rate limit 60/min. |
| DELETE | `/chats/:id/messages/:messageId/reactions/:emoji` | Yes | Remove caller's reaction (`:emoji` URL-encoded). 404 `REACTION_NOT_FOUND` if absent. |

Access: chat participant, or anyone authenticated for the global room (`:id` = global chat UUID). Message-list responses include `reactions: [{ emoji, count, reacted }]` aggregated per message (`reacted` is for the caller; always `false` for anonymous reads). Stored in `message_reactions` (PK `(message_id, user_id, emoji)`).

### Global Chat ("Grails Chat")
A single room seeded as `chats` row `00000000-0000-0000-0000-000000000001` (`type = 'global'`, **no** `chat_participants` rows — access control and fan-out branch on the UUID; constant `GLOBAL_CHAT_ID` in `src/services/global-chat.ts`). Anyone can read; only authenticated users can send, with daily quotas by tier derived from ENS ownership (`ens_names.owner_address`): owns a name with `metadata->>'avatar'` → `quota_with_avatar` (NULL = unlimited); owns a name without avatar → `quota_with_name` (default 20/day); no names → `quota_without_name` (default 1/day). Tier is Redis-cached 5 min; quota counting is a COUNT of the sender's global messages since UTC midnight (soft-deleted still count). Config lives in single-row `global_chat_config`, editable via the admin endpoints below.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET    | `/chats/global` | No | Room info: `{ chat_id, title, enabled, max_message_length, images_enabled, max_image_bytes, last_message_at }`. Cached 15s. |
| GET    | `/chats/global/messages` | Optional | Public cursor pagination (`?before&limit`), same shape as DM messages plus `reactions`. Identity is resolved client-side from `sender_address` (same as DMs). |
| POST   | `/chats/global/messages` | Yes | Send `{ body }` + optional `reply_to_message_id` (live global message, else 400 `INVALID_REPLY_TARGET`). 201 → `{ message, quota }`. Errors: 403 `GLOBAL_CHAT_DISABLED`/`CHAT_BANNED`, 400 `MESSAGE_TOO_LONG`, 429 `QUOTA_EXCEEDED` (details = quota snapshot). Rate limit 10/min. Fires `chat_reply`/`chat_mention` notifications. |
| POST   | `/chats/global/messages/image` | Yes | Image variant (multipart: `file` + optional `body` caption + optional `reply_to_message_id`). Same quota/ban/rate-limit enforcement as the text send; counts as one message against the daily quota. Gated by `images_enabled` (403 `IMAGES_DISABLED`). 201 → `{ message, quota }` where `message.attachment` carries the served image URL. |
| GET    | `/chats/global/quota` | Yes | Caller's `{ tier, used, limit, remaining, resets_at }` (`limit: null` = unlimited). |
| GET    | `/chats/global/online-users` | No | Recently ACTIVE users (24h window of `last_seen_at` — touched by ActivityLogger on any authed request — falling back to `last_sign_in`), newest activity first as `last_active`; excludes stubs and chat-banned users. Cached 15s. |

Ban scopes (`chat_user_status`): `status = 'banned'` is the **all-chats** ban (blocks DMs, chat creation, reactions, and global chat). `global_status = 'banned'` is the **global-chat-only** ban (blocks global messages and reactions; DMs unaffected; reading stays public). The two are independent columns — setting/lifting one never touches the other. Both exclude the user from `/chats/global/online-users`.

The global send route's per-minute rate limit reads `global_chat_config.rate_limit_per_minute` per request (Redis-cached config; admin PATCH applies immediately).

Admin (all `requireAuth + requireAdmin`, under `/chats/admin`):

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/chats/admin/global/messages` | Moderation list. Filters: `sender` (address or user id), `status` (all\|visible\|deleted), `from`/`to`, `page`/`limit`. Raw body returned even when deleted. Rows include `sender_mod_status` + `sender_global_status` + `deleted_by`/`deleted_reason`/`deleted_by_admin`. |
| DELETE | `/chats/admin/global/messages/:messageId` | Soft-delete one message: `{ reason }`. Logs `delete_message` to `chat_moderation_log`, broadcasts `chat:message_deleted` to global subscribers. |
| POST   | `/chats/admin/global/users/:userId/ban` | Global-chat-only ban: `{ reason }`. Logs `global_ban`. (All-chats ban remains `/chats/admin/users/:userId/ban`.) |
| POST   | `/chats/admin/global/users/:userId/unban` | Lift a global-only ban: `{ reason? }`. Logs `global_unban`. |
| GET    | `/chats/admin/global/config` | Current `global_chat_config`. |
| PATCH  | `/chats/admin/global/config` | Partial update of `enabled`, `quota_with_avatar` (explicit `null` = unlimited), `quota_with_name`, `quota_without_name`, `max_message_length`, `rate_limit_per_minute` (1–600), `images_enabled` (image kill switch, all chats), `message_retention_days` (global-only message cap), `image_retention_days` (all-chats image expiry). Logs `config_update`. |

### Chat Images
Users can attach one image per message in any chat (DM or global) via the multipart `…/messages/image` endpoints above. Images are stored in the Railway S3-compatible bucket (`config.storage`) under `chat/<chatId>/<uuid>.<ext>`, recorded in `message_attachments`, and served back through a proxy:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/chats/images/*` | Optional | Streams a chat image from the bucket (5-min in-memory cache). Global-chat images are public; DM/group images require the caller to be a participant of the owning chat. Returns 410 once expired, 404 if unknown. |

Controls live in `global_chat_config` (admin PATCH above): `images_enabled` is the master kill switch for image sending across **all** chats; `message_retention_days` (default 30) hard-deletes **global** messages past the cap; `image_retention_days` (default 180) expires images in **all** chats. Admin message deletion also pulls the attached bucket object immediately. Upload limits: ≤ `CHAT_IMAGE_MAX_BYTES` (default 10 MB), MIME jpeg/png/gif/webp. Shared helpers in `src/services/chat-images.ts`; serving route in `src/routes/chat-images.ts`.

### Message Blocks (Auth Required)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET    | `/me/blocks` | Yes | List the caller's blocks. |
| POST   | `/me/blocks` | Yes | Block a user: `{ user: address \| ens }`. |
| DELETE | `/me/blocks/:userId` | Yes | Unblock. |

### WebSocket Endpoints
| Path | Description |
|------|-------------|
| `/ws/events` | General event subscriptions |
| `/ws/orders` | Order status updates |
| `/ws/activity` | Real-time activity feed |
| `/ws/chats` | Chat events (`?token=<jwt>` optional: token-less = anonymous read-only global chat access) |
| `/ws/status` | WebSocket connection stats |

## WebSocket Protocol

### /ws/chats
Real-time chat events. JWT via query param: `wss://host/ws/chats?token=<jwt>`. The token is **optional**: token-less connections are anonymous read-only clients that may only `subscribe_global`/`unsubscribe_global`/`ping` (anything else returns an error frame). A present-but-invalid token still closes with 4401.

Client → server:
```json
{ "type": "subscribe" }                        // enroll for all of caller's chats (auth required)
{ "type": "unsubscribe" }
{ "type": "subscribe_global" }                 // global chat events (works for anonymous clients too)
{ "type": "unsubscribe_global" }
{ "type": "typing",      "chat_id": "<uuid>" } // ephemeral; not stored in DB (auth required)
{ "type": "stop_typing", "chat_id": "<uuid>" }
{ "type": "ping" }
```

Server → client (event types):
- `chat:message_new` — `{ chat_id, message }` (clients route on `chat_id` = global UUID; `message.reply_to` carries the parent preview when it's a reply)
- `chat:message_edited` — `{ chat_id, message }` (updated row; clients patch `body` + `edited_at`)
- `notification:unread` — `{}` (sent to specific users after a `chat_reply`/`chat_mention` notification is written; client re-fetches its unread count instead of waiting for the ~30s poll)
- `chat:message_deleted` — `{ chat_id, message_id, deleted_by_admin }` (`deleted_by_admin` distinguishes admin moderation from author self-delete)
- `chat:read` — `{ chat_id, user_id, last_read_message_id }`
- `chat:typing` / `chat:typing_stop` — `{ chat_id, user_id }`
- `chat:created` — `{ chat }` (sent to participants when a new chat is created)
- `chat:reaction_added` / `chat:reaction_removed` — `{ chat_id, message_id, user_id, address, emoji, count }` (`count` = absolute per-emoji count after the change, for idempotent cache patching)

Typing events are server-throttled to ~5/sec per (user, chat); typing in the global room fans out to global subscribers without a participant check. New-message fan-out is driven by an `AFTER INSERT` trigger on `messages` that emits `pg_notify('chat_message_created', …)`; the in-process `ChatNotifier` listens and calls `broadcastChatEvent()` on the relevant participant sockets (or `broadcastGlobalChatEvent()` for the global room — every `subscribe_global` socket, incl. anonymous). Reaction and admin-deletion events are broadcast directly from the route handlers.

### /ws/activity
Real-time activity feed with filters:
```json
// Subscribe to all activity
{ "type": "subscribe_all" }

// Subscribe to specific address
{ "type": "subscribe_address", "address": "0x..." }

// Subscribe to specific ENS name
{ "type": "subscribe_name", "name": "vitalik.eth" }

// Subscribe to a club (single subscription, replaces previous)
{ "type": "subscribe_club", "club": "10k" }

// Filter by event types
{ "type": "set_event_filter", "filter_type": "include", "event_types": ["sale", "listing"] }
{ "type": "clear_event_filter" }

// Filter by platform/source (opensea, grails, blockchain, vision, blur, looksrare, x2y2, snipezone, enstools, rotki, other)
{ "type": "set_platform_filter", "filter_type": "include", "platforms": ["opensea", "grails"] }
{ "type": "set_platform_filter", "filter_type": "exclude", "platforms": ["blockchain"] }
{ "type": "clear_platform_filter" }

// Filter by price threshold (decimal wei strings; either bound optional)
{ "type": "set_price_filter", "min_price_wei": "1000000000000000000", "max_price_wei": "5000000000000000000" }
{ "type": "clear_price_filter" }

// Filter to the caller's watchlisted names (requires connecting with ?token=<jwt>)
{ "type": "set_watchlist_filter", "list_id": 42 }   // list_id optional; omitted = all lists
{ "type": "clear_watchlist_filter" }
```

To use the watchlist filter, connect with a JWT: `wss://host/ws/activity?token=<jwt>` (same as `/ws/chats`). Connections without a token still work for every other filter; `set_watchlist_filter` returns an `error` if the socket isn't authenticated.

Event-type, platform, price, and watchlist filters are independent — all must pass for an event to be sent. Filter ACKs include a `filter_kind` (`event_type`, `platform`, `price`, or `watchlist`) so clients can disambiguate. The price filter requires a real, in-range, ETH/WETH-denominated price while a bound is active; no-price events (e.g. pure transfers) are excluded. The watchlist set is snapshotted when `set_watchlist_filter` is received — re-send it to refresh after the user edits their watchlist.

## Search & Filtering

**Endpoint:** `GET /api/v1/search`

**Query format:** `filters[filterName]=value` (e.g., `?filters[showListings]=true&filters[minLength]=3`)

**Pagination:** `page` (default: 1), `limit` (default: 20, max: 100)

**Sorting:** `sortBy` + `sortOrder` (asc/desc)

### Search Filters

| Filter | Type | Description | Validation Rule |
|--------|------|-------------|-----------------|
| `showListings` | boolean | Only names with active listings | `listings[]` has item with `status='active'` |
| `showUnlisted` | boolean | Only names without active listings | `listings[]` empty or no active status |
| `minPrice` | string | Minimum price (wei) | Listing price >= value |
| `maxPrice` | string | Maximum price (wei) | Listing price <= value |
| `minLength` | number | Minimum name length (excl. .eth) | Label length >= value |
| `maxLength` | number | Maximum name length (excl. .eth) | Label length <= value |
| `hasNumbers` | boolean | Contains/excludes digits | Name matches/doesn't match `/\d/` |
| `hasEmoji` | boolean | Contains/excludes emoji | Name has/lacks emoji chars |
| `clubs[]` | string[] | Filter by club (999, 10k, 100k, etc.) | `clubs[]` includes requested club |
| `inAnyClub` | boolean | In any club / not in any club | `clubs[]` non-empty / empty |
| `isExpired` | boolean | Expired / not expired | `expiry_date` < now / > now |
| `isGracePeriod` | boolean | In 90-day grace period | Expired within last 90 days |
| `isPremiumPeriod` | boolean | In premium auction period | Expired 90-111 days ago |
| `expiringWithinDays` | number | Expiring within X days | `expiry_date` between now and now+X days |
| `hasSales` | boolean | Has/lacks sale history | `last_sale_date` set / null |
| `lastSoldAfter` | ISO date | Sold after date | `last_sale_date` >= value |
| `lastSoldBefore` | ISO date | Sold before date | `last_sale_date` <= value |
| `owner` | address | Filter by owner | `owner` matches address |

### Sort Options

| Value | Description |
|-------|-------------|
| `price` | Sort by listing price |
| `expiry_date` | Sort by expiration date |
| `registration_date` | Sort by registration date |
| `last_sale_date` | Sort by last sale date |
| `character_count` | Sort by name length |
| `watchers_count` | Sort by watcher count |

### Example Requests

```bash
# Names with active listings
curl 'http://localhost:3000/api/v1/search?filters[showListings]=true&limit=10'

# Unlisted names
curl 'http://localhost:3000/api/v1/search?filters[showUnlisted]=true&limit=10'

# 3-5 char names with numbers, in 10k club, priced 1-5 ETH
curl 'http://localhost:3000/api/v1/search?filters[hasNumbers]=true&filters[minLength]=3&filters[maxLength]=5&filters[clubs][]=10k&filters[minPrice]=1000000000000000000&filters[maxPrice]=5000000000000000000'

# Names in grace period
curl 'http://localhost:3000/api/v1/search?filters[isGracePeriod]=true&limit=10'
```

## Database Tables

### Core Tables
| Table | Description |
|-------|-------------|
| `ens_names` | ENS domain info (token_id, name, owner, expiry, clubs, metadata) |
| `listings` | Active marketplace listings with Seaport order data |
| `offers` | Incoming offers on ENS names |
| `sales` | Completed sale records |
| `users` | User accounts with wallet addresses |
| `watchlist` | User watchlist entries with notification preferences |
| `notifications` | User notifications |
| `nonces` | SIWE authentication nonces |
| `name_views` | View tracking (unique per user/IP per name) |
| `name_votes` | User votes on names (upvote/downvote) |
| `activity_history` | Activity feed events |
| `cart_items` | Shopping cart items |
| `legends` | ENS Legend mint records |
| `poap_links` | POAP claim links |
| `mutelist` | Addresses to filter from activity broadcasts |
| `ai_recommendations` | Cached AI similar-name suggestions (label, recommendations JSONB, model, expires_at) |
| `chats` | Chat threads (direct or group). UUID PK; `dm_key` unique for idempotent direct creation |
| `chat_participants` | Per-(chat,user) state: read position, mute, role, soft-leave |
| `messages` | Chat messages (UUID PK, soft-delete via `deleted_at`; `deleted_by`/`deleted_reason` attribute who deleted + why; `edited_at` stamped on edit; `reply_to_message_id` self-FK for threaded replies) |
| `message_blocks` | Per-user message block list (`blocker_user_id`, `blocked_user_id`) |
| `message_reactions` | Emoji reactions on messages (PK `(message_id, user_id, emoji)`) |
| `message_attachments` | Image attachments on messages (`storage_key`, `chat_id`, `byte_size`, `created_at`, `expired_at`); drives the 180-day image-expiry worker |
| `global_chat_config` | Single-row global chat config (quota tiers, max length, enabled, `images_enabled`, `message_retention_days`, `image_retention_days`) |

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/grails
DATABASE_DIRECT_URL=postgresql://...  # Direct connection for LISTEN/NOTIFY
DB_MAX_CONNECTIONS=20

# API Server
API_PORT=3000
API_HOST=0.0.0.0
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
RATE_LIMIT_MAX=150
RATE_LIMIT_WINDOW=60000

# Authentication
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h

# Blockchain
RPC_URL=https://eth-mainnet.alchemyapi.io/v2/your-key
CHAIN_ID=1
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
SEAPORT_ADDRESS=0x0000000000000068F116a894984e2DB1123eB395

# OpenSea
OPENSEA_API_KEY=your_opensea_api_key
OPENSEA_STREAM_URL=wss://stream.openseabeta.com/socket/websocket

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_INDEX=ens_names

# The Graph
THE_GRAPH_ENS_SUBGRAPH_URL=https://gateway.thegraph.com/api/subgraphs/id/...
THE_GRAPH_API_KEY=your-graph-api-key

# Redis (Optional)
REDIS_URL=redis://localhost:6379
REDIS_ENABLED=true
CACHE_TTL_SECONDS=15

# Email
SMTP_SERVER=smtp.example.com
SMTP_PORT=587
SMTP_LOGIN=user@example.com
SMTP_PASSWORD=password
FROM_EMAIL=noreply@grails.market
ENABLE_EMAIL=true

# POAP
POAP_API_KEY=your-poap-api-key
POAP_COLLECTION_ID=213962

# Frontend
FRONTEND_URL=http://localhost:3001

# Storage (Railway S3-compatible bucket — shared by notification + chat images)
BUCKET=your-bucket
ACCESS_KEY_ID=your-access-key
SECRET_ACCESS_KEY=your-secret
ENDPOINT=https://gateway.storjshare.io  # or Railway bucket endpoint
REGION=auto
CHAT_IMAGE_MAX_BYTES=10485760  # max chat image upload size (default 10 MB)

# Monitoring
LOG_LEVEL=info
```

## Services

### Activity Notifier (`src/services/activity-notifier.ts`)
- Listens for PostgreSQL `activity_created` notifications via LISTEN/NOTIFY
- Broadcasts activity events to WebSocket clients
- Filters out muted addresses
- Uses direct database connection (bypasses PgBouncer)

### Chat Notifier (`src/services/chat-notifier.ts`)
- Listens for PostgreSQL `chat_message_created` notifications (emitted by trigger on `messages` insert)
- Loads the message + participants and calls `broadcastChatEvent` on `/ws/chats` clients
- Uses direct database connection (bypasses PgBouncer), same pattern as Activity Notifier
- Chat is intentionally isolated from the `notifications` table and `send-notification` queue

### Name Views Service (`src/services/name-views.ts`)
- Tracks unique views per user/IP per ENS name
- Hashes IP addresses with SHA-256 for privacy
- View counts updated via database trigger

### Search Service (`src/services/search.ts`)
- Elasticsearch query builder
- Supports text search, filters, sorting, pagination
- Returns name strings to be enriched by response builder

## Middleware

### Authentication (`src/middleware/auth.ts`)
- `requireAuth`: Requires valid JWT token
- `optionalAuth`: Parses JWT if present, continues if not
- Attaches `request.user` with `sub` (user ID), `address`

### Cache (`src/middleware/cache.ts`)
- Redis-based response caching
- `cacheHandler`: Default 15-second TTL
- `longCacheHandler`: 60-second TTL
- Returns `X-Cache: HIT/MISS` header

## Common Commands

```bash
# Development
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm start            # Production mode

# Database
npm run db:migrate   # Run migrations
npm run db:generate  # Generate client

# Testing
npm test             # Run tests
npm run lint         # Check code style
```

## Important Files
| File | Purpose |
|------|---------|
| `src/index.ts` | Main server entry, middleware setup |
| `src/routes/index.ts` | Route registration |
| `src/services/search.ts` | Elasticsearch query builder |
| `src/services/activity-notifier.ts` | Real-time activity broadcasts |
| `src/middleware/auth.ts` | JWT authentication |
| `src/utils/response-builder.ts` | Search result enrichment |
| `src/queue.ts` | pg-boss queue client |

## Integration Points
- **Indexer Service**: Shares database, provides blockchain data
- **WAL Listener**: Syncs PostgreSQL changes to Elasticsearch
- **Workers Service**: Consumes job queue for async processing
- **Frontend**: Consumes REST API and WebSocket endpoints

## Troubleshooting

### Common Issues
1. **Elasticsearch search fails**
   - Check `ELASTICSEARCH_URL` is accessible
   - Verify index exists and has mappings

2. **Activity WebSocket not broadcasting**
   - Check `DATABASE_DIRECT_URL` for LISTEN/NOTIFY
   - Verify PostgreSQL trigger is installed

3. **Redis cache not working**
   - Check `REDIS_ENABLED=true`
   - Verify Redis connection

4. **JWT authentication fails**
   - Check `JWT_SECRET` is set
   - Verify token hasn't expired

### Testing Endpoints
```bash
# Health check
curl http://localhost:3000/api/v1/health

# Get listings
curl http://localhost:3000/api/v1/listings

# Search names
curl "http://localhost:3000/api/v1/names/search?q=vitalik&filters[minLength]=3"

# Get trending
curl "http://localhost:3000/api/v1/trending/composite?period=24h&limit=10"
```
