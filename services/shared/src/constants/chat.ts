/**
 * The single well-known global "Grails Chat" room — a `chats` row with
 * `type = 'global'` and NO `chat_participants` rows, seeded by migration 0880.
 * Defined here in shared so every service (API, workers) agrees on one value
 * instead of duplicating the literal.
 */
export const GLOBAL_CHAT_ID = '00000000-0000-0000-0000-000000000001';
