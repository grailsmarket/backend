import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool } from '../../../shared/src';
import { requireAuth, requireMinTier } from '../middleware/auth';
import { SearchFiltersSchema, SearchSortBySchema } from './search';

const MAX_SAVED_SEARCHES_PER_USER = 25;

const SortOrderSchema = z.enum(['asc', 'desc']);

const CreateSavedSearchSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  q: z.string().max(200).optional(),
  filters: SearchFiltersSchema.optional(),
  sortBy: SearchSortBySchema.optional(),
  sortOrder: SortOrderSchema.optional(),
  isDefault: z.boolean().default(false),
});

const UpdateSavedSearchSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  q: z.string().max(200).nullable().optional(),
  filters: SearchFiltersSchema.optional(),
  sortBy: SearchSortBySchema.nullable().optional(),
  sortOrder: SortOrderSchema.nullable().optional(),
  isDefault: z.boolean().optional(),
});

function formatSavedSearch(row: any) {
  return {
    id: row.id,
    name: row.name,
    q: row.query,
    filters: row.filters,
    sortBy: row.sort_by,
    sortOrder: row.sort_order,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function savedSearchesRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const preHandler = [requireAuth, requireMinTier('plus')];

  // GET /  — list all saved searches for the authenticated user
  fastify.get('/', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);

    const result = await pool.query(
      `SELECT id, name, query, filters, sort_by, sort_order, is_default, created_at, updated_at
       FROM saved_searches
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at ASC`,
      [userId]
    );

    return reply.send({
      success: true,
      data: {
        savedSearches: result.rows.map(formatSavedSearch),
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // GET /:id  — get a single saved search
  fastify.get('/:id', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const { id } = request.params as { id: string };
    const savedSearchId = parseInt(id);

    if (isNaN(savedSearchId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_ID', message: 'Saved search ID must be a number' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const result = await pool.query(
      `SELECT id, user_id, name, query, filters, sort_by, sort_order, is_default, created_at, updated_at
       FROM saved_searches
       WHERE id = $1`,
      [savedSearchId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Saved search not found' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    if (result.rows[0].user_id !== userId) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not own this saved search' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    return reply.send({
      success: true,
      data: formatSavedSearch(result.rows[0]),
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /  — create a new saved search
  fastify.post('/', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);

    let body;
    try {
      body = CreateSavedSearchSchema.parse(request.body);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      throw error;
    }

    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM saved_searches WHERE user_id = $1',
      [userId]
    );
    if (countResult.rows[0].count >= MAX_SAVED_SEARCHES_PER_USER) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'LIMIT_EXCEEDED',
          message: `Maximum of ${MAX_SAVED_SEARCHES_PER_USER} saved searches allowed`,
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (body.isDefault) {
          await client.query(
            'UPDATE saved_searches SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE',
            [userId]
          );
        }

        const result = await client.query(
          `INSERT INTO saved_searches (user_id, name, query, filters, sort_by, sort_order, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, name, query, filters, sort_by, sort_order, is_default, created_at, updated_at`,
          [
            userId,
            body.name,
            body.q ?? null,
            JSON.stringify(body.filters ?? {}),
            body.sortBy ?? null,
            body.sortOrder ?? null,
            body.isDefault,
          ]
        );

        await client.query('COMMIT');

        return reply.status(201).send({
          success: true,
          data: formatSavedSearch(result.rows[0]),
          meta: { timestamp: new Date().toISOString() },
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (error.code === '23505') {
        return reply.status(409).send({
          success: false,
          error: { code: 'DUPLICATE_SEARCH_NAME', message: 'A saved search with that name already exists' },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      throw error;
    }
  });

  // PUT /:id  — update a saved search
  fastify.put('/:id', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const { id } = request.params as { id: string };
    const savedSearchId = parseInt(id);

    if (isNaN(savedSearchId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_ID', message: 'Saved search ID must be a number' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    let body;
    try {
      body = UpdateSavedSearchSchema.parse(request.body);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      throw error;
    }

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (body.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(body.name);
    }
    if (body.q !== undefined) {
      setClauses.push(`query = $${paramIndex++}`);
      values.push(body.q);
    }
    if (body.filters !== undefined) {
      setClauses.push(`filters = $${paramIndex++}`);
      values.push(JSON.stringify(body.filters));
    }
    if (body.sortBy !== undefined) {
      setClauses.push(`sort_by = $${paramIndex++}`);
      values.push(body.sortBy);
    }
    if (body.sortOrder !== undefined) {
      setClauses.push(`sort_order = $${paramIndex++}`);
      values.push(body.sortOrder);
    }
    if (body.isDefault !== undefined) {
      setClauses.push(`is_default = $${paramIndex++}`);
      values.push(body.isDefault);
    }

    if (setClauses.length === 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'No fields to update' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const check = await client.query(
          'SELECT user_id FROM saved_searches WHERE id = $1',
          [savedSearchId]
        );
        if (check.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Saved search not found' },
            meta: { timestamp: new Date().toISOString() },
          });
        }
        if (check.rows[0].user_id !== userId) {
          await client.query('ROLLBACK');
          return reply.status(403).send({
            success: false,
            error: { code: 'FORBIDDEN', message: 'You do not own this saved search' },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        if (body.isDefault === true) {
          await client.query(
            'UPDATE saved_searches SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE AND id != $2',
            [userId, savedSearchId]
          );
        }

        values.push(savedSearchId);
        values.push(userId);
        const result = await client.query(
          `UPDATE saved_searches
           SET ${setClauses.join(', ')}
           WHERE id = $${paramIndex++} AND user_id = $${paramIndex}
           RETURNING id, name, query, filters, sort_by, sort_order, is_default, created_at, updated_at`,
          values
        );

        await client.query('COMMIT');

        return reply.send({
          success: true,
          data: formatSavedSearch(result.rows[0]),
          meta: { timestamp: new Date().toISOString() },
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (error.code === '23505') {
        return reply.status(409).send({
          success: false,
          error: { code: 'DUPLICATE_SEARCH_NAME', message: 'A saved search with that name already exists' },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      throw error;
    }
  });

  // DELETE /:id  — delete a saved search
  fastify.delete('/:id', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const { id } = request.params as { id: string };
    const savedSearchId = parseInt(id);

    if (isNaN(savedSearchId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_ID', message: 'Saved search ID must be a number' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const result = await pool.query(
      'DELETE FROM saved_searches WHERE id = $1 AND user_id = $2 RETURNING id',
      [savedSearchId, userId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Saved search not found or not owned by you' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    return reply.send({
      success: true,
      data: { message: 'Saved search deleted' },
      meta: { timestamp: new Date().toISOString() },
    });
  });
}
