/**
 * A user's ENSv2 PermissionedResolvers, with their own names for resolvers and records
 * ("configurations") and the resolver they want new names to use by default.
 *
 * Resolver data comes from the ENS worker (ensv2-records `/v2/resolvers` routes) and is passed
 * through unchanged under `resolver` / `record`; labels and the preferred resolver live in our
 * DB (`resolver_labels`, `users.preferred_resolver`, migration 0909) and are private to the user.
 */
import { config } from '../../../shared/src/config';

/** Minimal query interface, so the DB helpers can run against any pg Pool or client. */
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** An account's resolver as returned by the worker's `GET /v2/resolvers?account=`. */
export interface WorkerAccountResolver {
  address: string;
  manages_records: boolean;
  record_count: number;
  [field: string]: unknown;
}

/** A record ("configuration") as returned by the worker's `GET /v2/resolvers/:address/records`. */
export interface WorkerRecord {
  record_id: string;
  [field: string]: unknown;
}

export interface WorkerRecordsPage {
  resolver: string;
  record_count: number;
  default_record_id: string | null;
  limit: number;
  offset: number;
  records: WorkerRecord[];
}

export interface WorkerResolver {
  address: string;
  record_count: number;
  default_record_id: string | null;
  [field: string]: unknown;
}

export class EnsWorkerUnavailableError extends Error {}

/** Max label length, matching resolver_labels.label. */
export const MAX_LABEL_LENGTH = 64;

// ---------------------------------------------------------------------------
// ENS worker
// ---------------------------------------------------------------------------

/** GET a worker /v2 route. Null on 404; throws EnsWorkerUnavailableError on anything else that isn't 2xx. */
async function workerGet<T>(path: string): Promise<T | null> {
  if (!config.ensWorker.url) throw new EnsWorkerUnavailableError('ENS worker is not configured for this network');
  let response: Response;
  try {
    response = await fetch(`${config.ensWorker.url}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new EnsWorkerUnavailableError(`ENS worker request failed: ${(err as Error).message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new EnsWorkerUnavailableError(`ENS worker ${path}: ${response.status} ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

export async function fetchAccountResolvers(account: string): Promise<WorkerAccountResolver[]> {
  const body = await workerGet<{ resolvers: WorkerAccountResolver[] }>(`/v2/resolvers?account=${account}`);
  return body?.resolvers ?? [];
}

export function fetchResolver(address: string): Promise<WorkerResolver | null> {
  return workerGet<WorkerResolver>(`/v2/resolvers/${address}`);
}

export function fetchResolverRecords(address: string, limit: number, offset: number): Promise<WorkerRecordsPage | null> {
  return workerGet<WorkerRecordsPage>(`/v2/resolvers/${address}/records?limit=${limit}&offset=${offset}`);
}

/** One record by id (records are numbered from 1, so it's the page of size 1 at offset id - 1). */
export async function fetchResolverRecord(address: string, recordId: string): Promise<WorkerRecord | null> {
  const page = await fetchResolverRecords(address, 1, Number(recordId) - 1);
  return page?.records.find((r) => r.record_id === recordId) ?? null;
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

/** The user's labels for a resolver's records, by record id ('0' = the resolver itself). */
export async function getRecordLabels(db: Queryable, userId: number, resolver: string): Promise<Map<string, string>> {
  const r = await db.query(
    'SELECT record_id::text AS record_id, label FROM resolver_labels WHERE user_id = $1 AND resolver = $2',
    [userId, resolver],
  );
  return new Map(r.rows.map((row) => [row.record_id as string, row.label as string]));
}

/** The user's labels for resolvers themselves (record 0), by resolver address. */
export async function getResolverLabels(db: Queryable, userId: number): Promise<Map<string, string>> {
  const r = await db.query('SELECT resolver, label FROM resolver_labels WHERE user_id = $1 AND record_id = 0', [userId]);
  return new Map(r.rows.map((row) => [row.resolver as string, row.label as string]));
}

export async function setLabel(db: Queryable, userId: number, resolver: string, recordId: string, label: string): Promise<void> {
  await db.query(
    `INSERT INTO resolver_labels (user_id, resolver, record_id, label) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, resolver, record_id) DO UPDATE SET label = EXCLUDED.label, updated_at = NOW()`,
    [userId, resolver, recordId, label],
  );
}

/** True if a label was removed. */
export async function deleteLabel(db: Queryable, userId: number, resolver: string, recordId: string): Promise<boolean> {
  const r = await db.query('DELETE FROM resolver_labels WHERE user_id = $1 AND resolver = $2 AND record_id = $3', [
    userId,
    resolver,
    recordId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** Records of one resolver whose label contains `q` (case-insensitive), ordered by record id. */
export async function searchRecordLabels(
  db: Queryable,
  userId: number,
  resolver: string,
  q: string,
  limit: number,
  offset: number,
): Promise<{ total: number; matches: { recordId: string; label: string }[] }> {
  const pattern = likeContains(q);
  const where = `user_id = $1 AND resolver = $2 AND record_id > 0 AND label ILIKE $3`;
  const count = await db.query(`SELECT count(*)::int AS total FROM resolver_labels WHERE ${where}`, [userId, resolver, pattern]);
  const rows = await db.query(
    `SELECT record_id::text AS record_id, label FROM resolver_labels WHERE ${where} ORDER BY record_id LIMIT $4 OFFSET $5`,
    [userId, resolver, pattern, limit, offset],
  );
  return { total: count.rows[0].total, matches: rows.rows.map((r) => ({ recordId: r.record_id, label: r.label })) };
}

export async function getPreferredResolver(db: Queryable, userId: number): Promise<string | null> {
  const r = await db.query('SELECT preferred_resolver FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.preferred_resolver ?? null;
}

export async function setPreferredResolver(db: Queryable, userId: number, resolver: string | null): Promise<void> {
  await db.query('UPDATE users SET preferred_resolver = $2, updated_at = NOW() WHERE id = $1', [userId, resolver]);
}

/** Escapes LIKE wildcards so q matches literally. */
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export interface ResolverListItem {
  address: string;
  label: string | null;
  isPreferred: boolean;
  /** The worker's resolver object, unchanged. */
  resolver: WorkerAccountResolver;
}

export interface ResolverList {
  /** The user's preferred resolver; hasRoles is false once they no longer hold a role that can manage its records. */
  preferred: { address: string; label: string | null; hasRoles: boolean } | null;
  total: number;
  resolvers: ResolverListItem[];
}

/**
 * Attaches labels, puts the preferred resolver first (the rest keep the worker's order, oldest
 * first), and filters by `q`: a case-insensitive substring of the label or the address.
 */
export function buildResolverList(
  resolvers: WorkerAccountResolver[],
  labels: Map<string, string>,
  preferred: string | null,
  q?: string,
): ResolverList {
  const needle = q?.trim().toLowerCase();
  const items = resolvers
    .map((r) => {
      const address = r.address.toLowerCase();
      return { address, label: labels.get(address) ?? null, isPreferred: address === preferred, resolver: r };
    })
    .filter((item) => !needle || item.address.includes(needle) || (item.label?.toLowerCase().includes(needle) ?? false));
  items.sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred));

  const preferredEntry = preferred ? resolvers.find((r) => r.address.toLowerCase() === preferred) : undefined;
  return {
    preferred: preferred
      ? { address: preferred, label: labels.get(preferred) ?? null, hasRoles: Boolean(preferredEntry?.manages_records) }
      : null,
    total: items.length,
    resolvers: items,
  };
}

/** Pairs worker records with the user's labels. */
export function labelRecords(records: WorkerRecord[], labels: Map<string, string>) {
  return records.map((record) => ({ recordId: record.record_id, label: labels.get(record.record_id) ?? null, record }));
}
