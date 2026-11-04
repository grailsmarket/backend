import { BaseError as ViemBaseError } from 'viem';

// Postgres SQLSTATE classes/codes that mean "try again later", not "this data is bad":
// 08 connection, 53 insufficient resources, 57P0x server shutting down / restarting,
// 40001/40P01 serialization failure / deadlock, 55P03 lock not available, 57014 statement
// timeout or cancel.
const TRANSIENT_PG_CLASSES = ['08', '53'];
const TRANSIENT_PG_CODES = new Set(['57P01', '57P02', '57P03', '40001', '40P01', '55P03', '57014']);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
]);

// node-postgres raises these as plain Errors without a code
const TRANSIENT_PG_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error',
  'Connection ended unexpectedly',
];

/**
 * True when an error comes from infrastructure (database or RPC unreachable, overloaded or
 * timing out) rather than from the event itself. Infrastructure errors should be retried until
 * they clear; anything else (a constraint violation, bad data, a bug in a handler) will fail
 * the same way every time.
 *
 * Every viem error counts as transient: inside a handler they come from RPC calls (getBlock,
 * getTransaction), which fail for network reasons, not because of the event.
 */
export function isTransientError(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof ViemBaseError) return true;

    const code = typeof current.code === 'string' ? current.code : undefined;
    if (code) {
      if (TRANSIENT_NODE_CODES.has(code) || TRANSIENT_PG_CODES.has(code)) return true;
      if (code.length === 5 && TRANSIENT_PG_CLASSES.includes(code.slice(0, 2))) return true;
    }
    const message = typeof current.message === 'string' ? current.message : '';
    if (TRANSIENT_PG_MESSAGES.some((m) => message.includes(m))) return true;

    current = current.cause;
  }
  return false;
}
