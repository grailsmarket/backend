import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, safeNormalize, type APIResponse } from '../../../shared/src';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { longCacheHandler } from '../middleware/cache';
import { getIncidents } from '../services/compromised-names';

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .transform((a) => a.toLowerCase());

const ListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(200).default(50),
  status: z.enum(['active', 'resolved']).optional(),
  incident: z.string().optional(),
  q: z.string().optional(), // name substring or address (original owner / taker)
});

const CreateSchema = z.object({
  incident: z.string().min(1), // incident slug
  name: z.string().min(1),
  originalOwner: AddressSchema,
  allowedAddresses: z.array(AddressSchema).max(20).default([]),
  takenBy: AddressSchema.optional(),
  takenTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  takenAt: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
});

const UpdateSchema = z.object({
  allowedAddresses: z.array(AddressSchema).max(20).optional(),
  originalOwner: AddressSchema.optional(),
  status: z.enum(['active', 'resolved']).optional(),
  resolvedReason: z.string().max(64).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

function meta() {
  return { timestamp: new Date().toISOString(), version: '1.0.0' };
}

export async function compromisedNamesRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/compromised-names/incidents
   * Public. Exploit incidents and their malicious operator contracts — the app checks the
   * connected wallet's ENS registrar / NameWrapper approvals against these before a buy/offer.
   */
  fastify.get('/incidents', { preHandler: longCacheHandler }, async (_request, reply) => {
    const response: APIResponse = {
      success: true,
      data: { incidents: await getIncidents() },
      meta: meta(),
    };
    return reply.send(response);
  });

  /**
   * GET /api/v1/compromised-names/admin
   * Admin list with filters + exact pagination.
   */
  fastify.get('/admin', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const query = ListQuerySchema.parse(request.query);
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.status) {
      params.push(query.status);
      conditions.push(`cn.status = $${params.length}`);
    }
    if (query.incident) {
      params.push(query.incident);
      conditions.push(`ci.slug = $${params.length}`);
    }
    if (query.q) {
      const q = query.q.trim().toLowerCase();
      if (/^0x[a-f0-9]{40}$/.test(q)) {
        params.push(q);
        conditions.push(
          `(LOWER(cn.original_owner) = $${params.length} OR LOWER(cn.taken_by) = $${params.length} OR $${params.length} = ANY(SELECT LOWER(a) FROM unnest(cn.allowed_addresses) a))`
        );
      } else {
        params.push(`%${q}%`);
        conditions.push(`cn.name LIKE $${params.length}`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (query.page - 1) * query.limit;

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT cn.*, ci.slug AS incident_slug, en.owner_address AS current_owner,
                (SELECT COUNT(*) FROM listings l WHERE l.ens_name_id = cn.ens_name_id AND l.status = 'active') AS active_listings
           FROM compromised_names cn
           JOIN compromise_incidents ci ON ci.id = cn.incident_id
           LEFT JOIN ens_names en ON en.id = cn.ens_name_id
           ${where}
          ORDER BY active_listings DESC, cn.name
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM compromised_names cn
           JOIN compromise_incidents ci ON ci.id = cn.incident_id
           ${where}`,
        params
      ),
    ]);

    const total = parseInt(count.rows[0].count);
    const totalPages = Math.ceil(total / query.limit);

    const response: APIResponse = {
      success: true,
      data: {
        names: rows.rows,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
          hasNext: query.page < totalPages,
          hasPrev: query.page > 1,
        },
      },
      meta: meta(),
    };
    return reply.send(response);
  });

  /**
   * POST /api/v1/compromised-names/admin
   * Flag a single name (bulk loads go through the import-compromised-names script).
   */
  fastify.post('/admin', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const body = CreateSchema.parse(request.body);
    const name = safeNormalize(body.name);

    const incident = await pool.query(`SELECT id FROM compromise_incidents WHERE slug = $1`, [body.incident]);
    if (incident.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'INCIDENT_NOT_FOUND', message: `Incident "${body.incident}" not found` },
        meta: meta(),
      });
    }

    const result = await pool.query(
      `INSERT INTO compromised_names (
         incident_id, ens_name_id, name, token_id, original_owner, allowed_addresses,
         taken_by, taken_tx_hash, taken_at, notes
       )
       SELECT $1, en.id, $2, en.token_id, $3, $4, $5, $6, $7, $8
         FROM (SELECT 1) one
         -- Exact match only: 'VLAD.eth' is a different (non-normalized) token than 'vlad.eth'
         LEFT JOIN LATERAL (SELECT id, token_id FROM ens_names WHERE name = $2 ORDER BY id LIMIT 1) en ON TRUE
       ON CONFLICT (name) DO UPDATE SET
         incident_id = EXCLUDED.incident_id,
         original_owner = EXCLUDED.original_owner,
         allowed_addresses = EXCLUDED.allowed_addresses,
         taken_by = COALESCE(EXCLUDED.taken_by, compromised_names.taken_by),
         taken_tx_hash = COALESCE(EXCLUDED.taken_tx_hash, compromised_names.taken_tx_hash),
         taken_at = COALESCE(EXCLUDED.taken_at, compromised_names.taken_at),
         notes = COALESCE(EXCLUDED.notes, compromised_names.notes),
         status = 'active',
         resolved_at = NULL,
         resolved_reason = NULL,
         updated_at = NOW()
       RETURNING *`,
      [
        incident.rows[0].id,
        name,
        body.originalOwner,
        body.allowedAddresses,
        body.takenBy || null,
        body.takenTxHash || null,
        body.takenAt ? new Date(body.takenAt) : null,
        body.notes || null,
      ]
    );

    return reply.status(201).send({ success: true, data: result.rows[0], meta: meta() });
  });

  /**
   * PATCH /api/v1/compromised-names/admin/:id
   * Edit recovery wallets / original owner / notes, or manually resolve / re-activate.
   */
  fastify.patch('/admin/:id', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const id = parseInt((request.params as { id: string }).id);
    const body = UpdateSchema.parse(request.body);

    const sets: string[] = [];
    const values: any[] = [];
    const set = (column: string, value: any) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (body.allowedAddresses !== undefined) set('allowed_addresses', body.allowedAddresses);
    if (body.originalOwner !== undefined) set('original_owner', body.originalOwner);
    if (body.notes !== undefined) set('notes', body.notes);
    if (body.status === 'resolved') {
      set('status', 'resolved');
      set('resolved_reason', body.resolvedReason || 'manual');
      sets.push('resolved_at = NOW()');
    } else if (body.status === 'active') {
      set('status', 'active');
      sets.push('resolved_at = NULL', 'resolved_reason = NULL');
    }

    if (sets.length === 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'NO_UPDATES', message: 'No fields to update' },
        meta: meta(),
      });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE compromised_names SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length}
        RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Compromised name not found' },
        meta: meta(),
      });
    }

    return reply.send({ success: true, data: result.rows[0], meta: meta() });
  });
}
