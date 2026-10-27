import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import {
  EnsWorkerUnavailableError,
  MAX_LABEL_LENGTH,
  buildResolverList,
  deleteLabel,
  fetchAccountResolvers,
  fetchResolver,
  fetchResolverRecord,
  fetchResolverRecords,
  getPreferredResolver,
  getRecordLabels,
  getResolverLabels,
  labelRecords,
  searchRecordLabels,
  setLabel,
  setPreferredResolver,
} from '../services/resolver-preferences';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const AddressParams = z.object({ address: z.string().regex(ADDRESS_RE, 'Invalid resolver address') });
const RecordParams = AddressParams.extend({
  id: z.string().regex(/^[1-9][0-9]{0,77}$/, 'Record id must be a positive integer'),
});
const LabelBody = z.object({ label: z.string().trim().min(1).max(MAX_LABEL_LENGTH) });
const PreferredBody = z.object({ address: z.string().regex(ADDRESS_RE, 'Invalid resolver address').nullable() });
const SearchQuery = z.object({ q: z.string().trim().max(100).optional() });
const RecordsQuery = SearchQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const ok = <T>(data: T): APIResponse<T> => ({
  success: true,
  data,
  meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
});

const sendError = (reply: FastifyReply, status: number, code: string, message: string, details?: unknown) =>
  reply.status(status).send({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
    meta: { timestamp: new Date().toISOString() },
  });

/**
 * The caller's ENSv2 PermissionedResolvers (from the ENS worker), with their own names for
 * resolvers and records ("configurations") and their preferred resolver for new names.
 * Mounted at /api/v1/me/resolvers.
 */
export async function meResolversRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  const handle = async (reply: FastifyReply, what: string, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      if (error instanceof EnsWorkerUnavailableError) {
        fastify.log.warn({ error: error.message }, `${what}: ENS worker unavailable`);
        return sendError(reply, 503, 'ENS_WORKER_UNAVAILABLE', 'Resolver data is temporarily unavailable');
      }
      fastify.log.error({ error }, what);
      return sendError(reply, 500, 'INTERNAL_ERROR', `Failed to ${what}`);
    }
  };

  /**
   * GET /api/v1/me/resolvers?q=
   * Resolvers the caller holds any role on, preferred first, with their labels.
   * q filters by label or address (case-insensitive substring).
   */
  fastify.get('/', { preHandler: requireAuth }, (request, reply) =>
    handle(reply, 'list resolvers', async () => {
      const { q } = SearchQuery.parse(request.query);
      const userId = parseInt(request.user!.sub, 10);
      const [resolvers, labels, preferred] = await Promise.all([
        fetchAccountResolvers(request.user!.address),
        getResolverLabels(pool, userId),
        getPreferredResolver(pool, userId),
      ]);
      return reply.send(ok(buildResolverList(resolvers, labels, preferred, q)));
    }),
  );

  /**
   * PUT /api/v1/me/resolvers/preferred  { address: "0x…" | null }
   * Sets (or clears) the resolver new names should default to. The caller must hold a role
   * on it that can manage records.
   */
  fastify.put('/preferred', { preHandler: requireAuth }, (request, reply) =>
    handle(reply, 'set preferred resolver', async () => {
      const { address: raw } = PreferredBody.parse(request.body);
      const userId = parseInt(request.user!.sub, 10);
      const address = raw?.toLowerCase() ?? null;
      if (address) {
        const mine = await fetchAccountResolvers(request.user!.address);
        if (!mine.some((r) => r.address.toLowerCase() === address && r.manages_records)) {
          return sendError(reply, 400, 'NO_RESOLVER_ROLES', 'You do not hold a role that can manage records on this resolver');
        }
      }
      await setPreferredResolver(pool, userId, address);
      return reply.send(ok({ preferredResolver: address }));
    }),
  );

  /** PUT /api/v1/me/resolvers/:address/label  { label } */
  fastify.put('/:address/label', { preHandler: requireAuth }, (request, reply) =>
    handle(reply, 'label resolver', async () => {
      const address = AddressParams.parse(request.params).address.toLowerCase();
      const { label } = LabelBody.parse(request.body);
      if (!(await fetchResolver(address))) return sendError(reply, 404, 'RESOLVER_NOT_FOUND', 'Not a known PermissionedResolver');
      await setLabel(pool, parseInt(request.user!.sub, 10), address, '0', label);
      return reply.send(ok({ resolver: address, label }));
    }),
  );

  /** DELETE /api/v1/me/resolvers/:address/label */
  fastify.delete('/:address/label', { preHandler: requireAuth }, (request, reply) =>
    handle(reply, 'remove resolver label', async () => {
      const address = AddressParams.parse(request.params).address.toLowerCase();
      const removed = await deleteLabel(pool, parseInt(request.user!.sub, 10), address, '0');
      if (!removed) return sendError(reply, 404, 'LABEL_NOT_FOUND', 'No label for this resolver');
      return reply.send(ok({ resolver: address, label: null }));
    }),
  );

  /**
   * GET /api/v1/me/resolvers/:address/records?limit=&offset=&q=
   * The resolver's records with the caller's labels. Without q, pages through record ids;
   * with q, returns the records whose label contains q (case-insensitive).
   */
  fastify.get('/:address/records', { preHandler: requireAuth }, (request, reply) =>
    handle(reply, 'list resolver records', async () => {
      const address = AddressParams.parse(request.params).address.toLowerCase();
      const { q, limit, offset } = RecordsQuery.parse(request.query);
      const userId = parseInt(request.user!.sub, 10);

      if (q) {
        const resolver = await fetchResolver(address);
        if (!resolver) return sendError(reply, 404, 'RESOLVER_NOT_FOUND', 'Not a known PermissionedResolver');
        const { total, matches } = await searchRecordLabels(pool, userId, address, q, limit, offset);
        const records = await Promise.all(matches.map((m) => fetchResolverRecord(address, m.recordId)));
        return reply.send(
          ok({
            resolver: address,
            recordCount: resolver.record_count,
            defaultRecordId: resolver.default_record_id,
            total,
            limit,
            offset,
            records: matches.map((m, i) => ({ recordId: m.recordId, label: m.label, record: records[i] ?? null })),
          }),
        );
      }

      const [page, labels] = await Promise.all([fetchResolverRecords(address, limit, offset), getRecordLabels(pool, userId, address)]);
      if (!page) return sendError(reply, 404, 'RESOLVER_NOT_FOUND', 'Not a known PermissionedResolver');
      return reply.send(
        ok({
          resolver: address,
          recordCount: page.record_count,
          defaultRecordId: page.default_record_id,
          total: page.record_count,
          limit,
          offset,
          records: labelRecords(page.records, labels),
        }),
      );
    }),
  );

  /** PUT /api/v1/me/resolvers/:address/records/:id/label  { label } */
  fastify.put('/:address/records/:id/label', { preHandler: requireAuth }, (request, reply) =>
    handle(reply, 'label record', async () => {
      const params = RecordParams.parse(request.params);
      const address = params.address.toLowerCase();
      const { label } = LabelBody.parse(request.body);
      const resolver = await fetchResolver(address);
      if (!resolver) return sendError(reply, 404, 'RESOLVER_NOT_FOUND', 'Not a known PermissionedResolver');
      if (BigInt(params.id) > BigInt(resolver.record_count)) {
        return sendError(reply, 404, 'RECORD_NOT_FOUND', `This resolver has ${resolver.record_count} records`);
      }
      await setLabel(pool, parseInt(request.user!.sub, 10), address, params.id, label);
      return reply.send(ok({ resolver: address, recordId: params.id, label }));
    }),
  );

  /** DELETE /api/v1/me/resolvers/:address/records/:id/label */
  fastify.delete('/:address/records/:id/label', { preHandler: requireAuth }, (request, reply) =>
    handle(reply, 'remove record label', async () => {
      const params = RecordParams.parse(request.params);
      const address = params.address.toLowerCase();
      const removed = await deleteLabel(pool, parseInt(request.user!.sub, 10), address, params.id);
      if (!removed) return sendError(reply, 404, 'LABEL_NOT_FOUND', 'No label for this record');
      return reply.send(ok({ resolver: address, recordId: params.id, label: null }));
    }),
  );
}
