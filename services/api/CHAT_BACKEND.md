# Chat Backend Implementation

Direct messaging for Grails. Authenticated users can message each other by Ethereum address or ENS name, with multiple ongoing chats per user, opt-out, per-user blocks, read receipts, and typing indicators. v1 is direct (1:1) only; the data model and broadcast layer are group-chat-ready.

---

## Goals & Decisions

| Decision | Value |
|---|---|
| Naming | `chat` everywhere — never `conversation` |
| v1 scope | Direct (1:1) chats only |
| Group chats | Schema-ready, endpoints deferred (return 501) |
| Recipients without a Grails account | Stub `users` row auto-created; promoted on first SIWE sign-in |
| Opt-out semantics | **Hard block** — sender gets 403, message not stored |
| Block list | Per-user, ships in v1 |
| Read receipts | Yes; other participants' state visible |
| Typing indicators | Yes; ephemeral (no DB writes), server-throttled |
| Content types | Text only (1–4000 chars). `metadata` JSONB reserved for media |
| Notifications | Isolated from existing `notifications` table and `send-notification` queue. v1 has no email/in-app message notifications |
| Search | Not indexed in Elasticsearch in v1 |

---

## Architecture

```
Client ──HTTP──▶ /api/v1/chats…           (Fastify routes)
       └─WSS──▶ /ws/chats?token=<jwt>     (Fastify websocket)

POST /chats/:id/messages
   └─▶ INSERT messages   ──trigger──▶ pg_notify('chat_message_created', …)
                                           │
                                           ▼
                                  ChatNotifier (LISTEN client)
                                           │
                                           ▼
                                  broadcastChatEvent()
                                           │
                                           ▼
                                  /ws/chats sockets of participants
```

Real-time fan-out mirrors the activity feed pattern (`activity-notifier.ts`) — a dedicated `pg.Client` on `DATABASE_DIRECT_URL` listens for the channel, fetches the message + participant ids, and pushes to the in-process `chatClients` map.

Typing events bypass the database — the WS handler validates participation, applies a per-`(user, chat)` 200 ms throttle, then pushes directly to other participants' sockets.

`POST /chats/:id/read` and `DELETE …/messages/:messageId` write to Postgres and then call the relevant `broadcast…` helper directly (no LISTEN round-trip needed since the route already has the data).

---

## Data Model

All migrations in `services/api/migrations/seq/`, sequence `0844`–`0849`. Mirrored into `services/shared/src/db/schema.sql`.

### `users` (extended via `0844`)

```sql
ALTER TABLE users
  ADD COLUMN accept_messages BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN is_stub          BOOLEAN NOT NULL DEFAULT FALSE;
```

- `accept_messages = FALSE` → senders get **403** when starting a new chat with this user, or when sending into an existing chat that contains this user.
- `is_stub = TRUE` marks users created by the chat system before SIWE sign-in. Cleared on first successful auth (handled in `services/api/src/routes/auth.ts` — the verify upsert sets `is_stub = FALSE` on conflict).

### `chats` (`0845`)

```sql
CREATE TABLE chats (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type               VARCHAR(16) NOT NULL DEFAULT 'direct'
                       CHECK (type IN ('direct', 'group')),
  title              VARCHAR(120),                  -- group only; null for direct
  dm_key             VARCHAR(80) UNIQUE,            -- non-null for direct, null for group
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  last_message_at    TIMESTAMP                      -- denormalized for inbox sort
);
```

`dm_key` is `least(user_a_id, user_b_id) || ':' || greatest(user_a_id, user_b_id)`. The unique constraint makes "find-or-create direct chat" idempotent under concurrent writes — `INSERT … ON CONFLICT (dm_key) DO NOTHING; SELECT … WHERE dm_key = $1` always returns the canonical row. Group chats have `dm_key = NULL`.

### `chat_participants` (`0846`)

```sql
CREATE TABLE chat_participants (
  chat_id              UUID    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  joined_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  left_at              TIMESTAMP,
  role                 VARCHAR(16) NOT NULL DEFAULT 'member'
                         CHECK (role IN ('member', 'admin')),
  last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  muted                BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (chat_id, user_id)
);
```

`left_at` enables soft-leave for future group chats so message history is preserved for the leaver. `role` is a stub for group admin semantics. `muted` is a per-chat notification toggle (does not affect delivery).

### `messages` (`0847`)

```sql
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id         UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_user_id  INTEGER NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  content_type    VARCHAR(16) NOT NULL DEFAULT 'text'
                    CHECK (content_type IN ('text')),
  metadata        JSONB,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  edited_at       TIMESTAMP,
  deleted_at      TIMESTAMP
);
```

Soft-delete only — sender can clear their own message; `body` is nulled in the API response when `deleted_at` is set. To support attachments later, drop the `content_type` CHECK and widen — `metadata` JSONB is already in place.

The `last_read_message_id` FK on `chat_participants` is added in this migration after `messages` exists.

### `0848` — INSERT trigger on `messages`

```sql
CREATE FUNCTION notify_chat_message_created() RETURNS TRIGGER AS $$
BEGIN
  UPDATE chats SET last_message_at = NEW.created_at WHERE id = NEW.chat_id;
  PERFORM pg_notify(
    'chat_message_created',
    json_build_object('message_id', NEW.id, 'chat_id', NEW.chat_id)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_message_created_trigger
  AFTER INSERT ON messages FOR EACH ROW
  EXECUTE FUNCTION notify_chat_message_created();
```

### `message_blocks` (`0849`)

```sql
CREATE TABLE message_blocks (
  blocker_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
```

One-directional. Enforced at send time on both `POST /chats` and `POST /chats/:id/messages`.

---

## REST API

All routes are prefixed with `/api/v1`, all require `requireAuth`, all return the standard `APIResponse` envelope.

| Method | Path | Description |
|---|---|---|
| `POST`   | `/chats` | `{ recipient: address \| ens }` — create or fetch a direct chat (idempotent via `dm_key`). 501 for `recipients.length > 1`. Rate limit: 30/min. |
| `GET`    | `/chats` | Paginated inbox sorted by `last_message_at DESC NULLS LAST`. Each chat row includes `last_message`, `unread_count`, full `participants` JSON, and `is_blocked_by_me` (TRUE when the caller has the other participant in `message_blocks`). Query: `page`, `limit ≤ 100`. |
| `GET`    | `/chats/:id` | Chat detail + all participants and their `last_read_message_id`. Also returns `is_blocked_by_me` for the caller. 404 if caller is not a participant. |
| `PATCH`  | `/chats/:id` | `{ muted? }` — per-chat mute on caller's `chat_participants` row. |
| `GET`    | `/chats/:id/messages` | Cursor pagination. Query: `before=<message-uuid>`, `limit ≤ 100` (default 50). Returns `{ messages, nextCursor }`. `body` is nulled for soft-deleted messages. |
| `POST`   | `/chats/:id/messages` | `{ body }` — 1–4000 chars after trim. Rate limit: 30/min. |
| `POST`   | `/chats/:id/read` | `{ up_to_message_id }` — sets caller's `last_read_message_id`. Broadcasts `chat:read` to other participants. |
| `DELETE` | `/chats/:id/messages/:messageId` | Soft-deletes caller's own message. Broadcasts `chat:message_deleted`. |
| `GET`    | `/me/blocks` | List the caller's blocks. |
| `POST`   | `/me/blocks` | `{ user: address \| ens }` — block. Stub user is created if the target has no account. |
| `DELETE` | `/me/blocks/:userId` | Unblock. |
| `PATCH`  | `/users/me` | **Extended.** Now also accepts `acceptMessages: boolean`. |

### Send-message enforcement order (`POST /chats/:id/messages`)

1. **Participation.** Caller must be in `chat_participants` for `chat_id` (else 404 — never 403, to avoid leaking chat existence to non-participants).
2. **Block list.** No other participant has the caller in their `message_blocks` (else 403 `BLOCKED`).
3. **Opt-out.** All other participants have `accept_messages = TRUE` (else 403 `RECIPIENT_OPTED_OUT`). v1 only has one "other participant" since chats are direct, but the loop is in place for groups.
4. INSERT into `messages`. The trigger fires `pg_notify` and `ChatNotifier` fans out.

### Create-chat flow (`POST /chats`)

1. Resolve `recipient` to a `users.id`:
   - **Address**: lowercase, look up; if missing, INSERT a stub (`is_stub = TRUE`).
   - **ENS name**: query `ens_names.owner_address`; reject 404 if no row or no owner; then same lookup/stub path.
2. Reject `400 SELF_CHAT_FORBIDDEN` if recipient resolves to caller.
3. Block check (both directions).
4. Recipient `accept_messages` check.
5. Compute `dm_key`. `INSERT … ON CONFLICT (dm_key) DO NOTHING RETURNING *`.
   - On insert: insert two `chat_participants` rows, broadcast `chat:created` to the recipient.
   - On conflict: fetch existing chat by `dm_key`.
6. Return `{ chat, created }` (`201` if newly inserted, `200` if pre-existing).

---

## WebSocket Protocol — `/ws/chats`

Connect with: `wss://host/ws/chats?token=<jwt>`. The token query param is required because browser WebSocket APIs cannot set an `Authorization` header. Connection is closed with code `4401` on missing/invalid token.

### Client → server

```json
{ "type": "subscribe" }                         // enroll for events on all of caller's chats
{ "type": "unsubscribe" }                       // pause delivery without disconnecting
{ "type": "typing",      "chat_id": "<uuid>" }  // ephemeral; throttled to ~5/sec per (user, chat)
{ "type": "stop_typing", "chat_id": "<uuid>" }
{ "type": "ping" }                              // → { type: "pong" }
```

`typing` and `stop_typing` validate that the caller is a participant of the chat (cheap one-row query); non-participants receive `{ type: "error", message: "Not a participant" }`.

### Server → client

| Event | Payload | Trigger |
|---|---|---|
| `connected` | `{ clientId, userId, channel: "chats" }` | On socket open after JWT verify |
| `subscribed` / `unsubscribed` | `{ channel: "chats" }` | Acknowledgement |
| `chat:message_new` | `{ chat_id, message }` (full message + `sender_address`) | `chat_message_created` LISTEN → `ChatNotifier.handleMessageCreated` |
| `chat:message_deleted` | `{ chat_id, message_id }` | `DELETE /chats/:id/messages/:messageId` |
| `chat:read` | `{ chat_id, user_id, last_read_message_id }` | `POST /chats/:id/read` |
| `chat:typing` / `chat:typing_stop` | `{ chat_id, user_id }` | Direct from WS handler |
| `chat:created` | `{ chat }` | `POST /chats` when a new direct chat is opened |
| `pong` | `{ timestamp }` | Reply to `ping` |
| `error` | `{ message }` | Validation / auth errors |

All events carry `timestamp` (ISO-8601). Fan-out only delivers to clients whose `userId` is in the chat's participant set **and** whose `subscribed` flag is true.

The `/ws/status` endpoint reports `chatClients` count and per-client `{ id, userId, subscribed }` for debugging.

---

## File Map

| File | Role |
|---|---|
| `services/api/migrations/seq/0844_add_users_messaging_prefs.sql` | `accept_messages`, `is_stub` columns |
| `services/api/migrations/seq/0845_create_chats.sql` | `chats` table + `dm_key` unique index |
| `services/api/migrations/seq/0846_create_chat_participants.sql` | `chat_participants` |
| `services/api/migrations/seq/0847_create_messages.sql` | `messages` + back-fill participants FK |
| `services/api/migrations/seq/0848_messages_trigger.sql` | `chat_message_created` AFTER INSERT trigger |
| `services/api/migrations/seq/0849_create_message_blocks.sql` | `message_blocks` |
| `services/shared/src/db/schema.sql` | Mirror of new tables/triggers |
| `services/api/src/routes/chats.ts` | All chat HTTP endpoints |
| `services/api/src/routes/blocks.ts` | `/me/blocks` HTTP endpoints |
| `services/api/src/routes/users.ts` | Extended `PATCH /users/me` for `acceptMessages` |
| `services/api/src/routes/auth.ts` | SIWE upsert clears `is_stub` |
| `services/api/src/routes/websocket.ts` | `/ws/chats` handler, `chatClients` map, `broadcastChat*` helpers, typing throttle |
| `services/api/src/services/chat-notifier.ts` | LISTEN `chat_message_created` → `broadcastChatEvent` |
| `services/api/src/routes/index.ts` | Registers `chatsRoutes` at `/api/v1/chats`, `blocksRoutes` at `/api/v1/me/blocks` |
| `services/api/src/index.ts` | Starts/stops `ChatNotifier` alongside `ActivityNotifier` |
| `services/api/CLAUDE.md` | Endpoint and WebSocket reference for the API service |

### Reused, not re-implemented

- `getPostgresPool()` from `services/shared/src` — the connection pool.
- `requireAuth` middleware (`services/api/src/middleware/auth.ts`).
- `verifyToken()` from the same module — used by `/ws/chats` to authenticate query-param JWTs.
- `APIResponse` envelope.
- `@fastify/rate-limit` per-route override (same syntax as `ai-search.ts`).
- `pg.Client` + `DATABASE_DIRECT_URL` LISTEN pattern from `activity-notifier.ts`.
- Address normalization to lowercase before any DB lookup.
- ENS resolution via `ens_names.owner_address`.

---

## Rate Limiting

- **Global**: `@fastify/rate-limit` is registered at `services/api/src/index.ts` with `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` env vars.
- **`POST /chats`** and **`POST /chats/:id/messages`**: per-route override `{ max: 30, timeWindow: 60_000 }`.
- **WS typing events**: in-process throttle keyed `${userId}:${chatId}`, drops events under 200 ms apart.

---

## Out of Scope for v1 (and how to add later)

| Feature | Status | How to add |
|---|---|---|
| Group chats | Schema-ready | Add group-create / add-participant / leave routes. No migration needed — `chats.type='group'` is already valid, `chat_participants.role` and `left_at` are wired. |
| Attachments / media | Reserved | Drop the `content_type` CHECK constraint and re-add with widened values. `metadata JSONB` is in place. |
| Email / in-app notifications for messages | Deliberately omitted | Add a worker consuming a new `send-message-notification` queue. Publish from `POST /chats/:id/messages` after insert. |
| Server-side message search | Not indexed | Add a WAL listener trigger or worker that pushes new messages to a private Elasticsearch index keyed per user. |
| Message editing | Schema-ready | Add `PATCH /chats/:id/messages/:messageId` that updates `body` and sets `edited_at`. Broadcast new event `chat:message_edited`. |
| Read state for self vs. others | Already exposed | All participants' `last_read_message_id` is in the `GET /chats/:id` response. |
| Presence ("online now") | Not implemented | Track WS connect/disconnect timestamps in Redis with TTL; emit `chat:presence` when state changes. |

---

## Verification

Run migrations, then exercise each path. The plan file at `~/.claude/plans/lets-change-all-instances-cheeky-dragon.md` contains the full curl-based verification script. Highlights:

```bash
# 1. Migrations
cd services/api && npm run db:migrate
psql "$DATABASE_URL" -c '\d chats' -c '\d chat_participants' -c '\d messages' -c '\d message_blocks'

# 2. Build
npm run build  # from repo root — all four services compile

# 3. Two-user happy path (with two JWTs $T_A, $T_B)
curl -X POST :3000/api/v1/chats -H "Authorization: Bearer $T_A" -d '{"recipient":"0xBBB…"}'
curl -X POST :3000/api/v1/chats/$C/messages -H "Authorization: Bearer $T_A" -d '{"body":"gm"}'
curl :3000/api/v1/chats -H "Authorization: Bearer $T_B"

# 4. Opt-out hard block
curl -X PATCH :3000/api/v1/users/me -H "Authorization: Bearer $T_B" -d '{"acceptMessages":false}'
curl -i -X POST :3000/api/v1/chats -H "Authorization: Bearer $T_A" -d '{"recipient":"0xBBB…"}'  # → 403

# 5. Block list
curl -X POST :3000/api/v1/me/blocks -H "Authorization: Bearer $T_B" -d '{"user":"0xAAA…"}'
curl -i -X POST :3000/api/v1/chats/$C/messages -H "Authorization: Bearer $T_A" -d '{"body":"hi"}'  # → 403

# 6. WebSocket real-time
wscat -c "ws://localhost:3000/ws/chats?token=$T_B"
# → send {"type":"subscribe"}, then POST a message from A — watch chat:message_new arrive

# 7. Cross-bleed check
psql "$DATABASE_URL" -c "SELECT count(*) FROM notifications WHERE type LIKE 'message%';"  # → 0
```

On boot, `services/api/src/index.ts` should log `Activity notifier started` and `Chat notifier started`. If the chat notifier fails to attach LISTEN, check `DATABASE_DIRECT_URL` (PgBouncer pool-mode `transaction` does not support LISTEN/NOTIFY).
