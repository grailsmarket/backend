import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool } from '../../../shared/src';
import { requireAuth, requireMinTier } from '../middleware/auth';

const MAX_DASHBOARDS_PER_USER = 10;
const MAX_WIDGETS_PER_DASHBOARD = 20;

// --- Widget type enum (matches frontend DashboardComponentType) ---

const WidgetType = z.enum([
  'domains',
  'top-sales',
  'top-offers',
  'top-registrations',
  'sales-chart',
  'offers-chart',
  'registrations-chart',
  'holders',
  'leaderboard',
  'activity',
]);

// --- Per-type config schemas (matches frontend instance configs) ---

const AnalyticsPeriod = z.enum(['24h', '7d', '30d', '1y', 'all']);
const AnalyticsSource = z.enum(['all', 'grails', 'opensea']);

const DomainsConfig = z.object({
  type: z.literal('domains'),
  viewType: z.enum(['grid', 'list']),
  filters: z.record(z.unknown()), // MarketplaceFiltersState is complex; store as-is
  filtersOpen: z.boolean(),
});

const AnalyticsListConfig = z.object({
  type: z.enum(['top-sales', 'top-offers', 'top-registrations']),
  period: AnalyticsPeriod,
  source: AnalyticsSource,
  category: z.string().nullable(),
});

const AnalyticsChartConfig = z.object({
  type: z.enum(['sales-chart', 'offers-chart', 'registrations-chart']),
  period: AnalyticsPeriod,
  category: z.string().nullable(),
});

const HoldersConfig = z.object({
  type: z.literal('holders'),
  categories: z.array(z.string()),
});

const LeaderboardConfig = z.object({
  type: z.literal('leaderboard'),
  sortBy: z.enum(['names_owned', 'names_in_clubs', 'expired_names', 'names_listed', 'names_sold', 'sales_volume']),
  sortOrder: z.enum(['asc', 'desc']),
  clubs: z.array(z.string()),
});

const ActivityConfig = z.object({
  type: z.literal('activity'),
  eventTypes: z.array(z.string()),
  category: z.string().nullable(),
});

const ComponentConfig = z.discriminatedUnion('type', [
  DomainsConfig,
  AnalyticsListConfig,
  AnalyticsChartConfig,
  HoldersConfig,
  LeaderboardConfig,
  ActivityConfig,
]);

// --- Layout item schema (matches react-grid-layout LayoutItem) ---

const LayoutItemSchema = z.object({
  i: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  minW: z.number().int().min(1).optional(),
  minH: z.number().int().min(1).optional(),
});

const BreakpointLayouts = z.object({
  lg: z.array(LayoutItemSchema).max(MAX_WIDGETS_PER_DASHBOARD),
  md: z.array(LayoutItemSchema).max(MAX_WIDGETS_PER_DASHBOARD),
  sm: z.array(LayoutItemSchema).max(MAX_WIDGETS_PER_DASHBOARD),
  xs: z.array(LayoutItemSchema).max(MAX_WIDGETS_PER_DASHBOARD),
});

// --- Dashboard schemas ---

const ComponentsMap = z.record(z.string(), ComponentConfig).refine(
  (map) => Object.keys(map).length <= MAX_WIDGETS_PER_DASHBOARD,
  { message: `Maximum of ${MAX_WIDGETS_PER_DASHBOARD} widgets allowed` }
);

const CreateDashboardSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  colOverride: z.number().int().min(1).max(4).nullable().default(null),
  layouts: BreakpointLayouts.default({ lg: [], md: [], sm: [], xs: [] }),
  components: ComponentsMap.default({}),
  nextId: z.number().int().min(1).default(1),
  isDefault: z.boolean().default(false),
});

const UpdateDashboardSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  colOverride: z.number().int().min(1).max(4).nullable().optional(),
  layouts: BreakpointLayouts.optional(),
  components: ComponentsMap.optional(),
  nextId: z.number().int().min(1).optional(),
  isDefault: z.boolean().optional(),
});

// --- Helper to map DB rows to API response format ---

function formatLayout(row: any) {
  return {
    id: row.id,
    name: row.name,
    colOverride: row.col_override,
    layouts: row.layouts,
    components: row.components,
    nextId: row.next_id,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Routes ---

export async function dashboardLayoutsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const preHandler = [requireAuth, requireMinTier('plus')];

  // GET /  — list all dashboards for the authenticated user
  fastify.get('/', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);

    const result = await pool.query(
      `SELECT id, name, col_override, layouts, components, next_id, is_default, created_at, updated_at
       FROM dashboard_layouts
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at ASC`,
      [userId]
    );

    return reply.send({
      success: true,
      data: {
        layouts: result.rows.map(formatLayout),
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // GET /:id  — get a single dashboard
  fastify.get('/:id', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const { id } = request.params as { id: string };
    const layoutId = parseInt(id);

    if (isNaN(layoutId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_ID', message: 'Layout ID must be a number' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const result = await pool.query(
      `SELECT id, user_id, name, col_override, layouts, components, next_id, is_default, created_at, updated_at
       FROM dashboard_layouts
       WHERE id = $1`,
      [layoutId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Dashboard layout not found' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    if (result.rows[0].user_id !== userId) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not own this dashboard layout' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    return reply.send({
      success: true,
      data: formatLayout(result.rows[0]),
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /  — create a new dashboard
  fastify.post('/', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);

    let body;
    try {
      body = CreateDashboardSchema.parse(request.body);
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

    // Check dashboard limit
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM dashboard_layouts WHERE user_id = $1',
      [userId]
    );
    if (countResult.rows[0].count >= MAX_DASHBOARDS_PER_USER) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'LIMIT_EXCEEDED',
          message: `Maximum of ${MAX_DASHBOARDS_PER_USER} dashboards allowed`,
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
            'UPDATE dashboard_layouts SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE',
            [userId]
          );
        }

        const result = await client.query(
          `INSERT INTO dashboard_layouts (user_id, name, col_override, layouts, components, next_id, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, name, col_override, layouts, components, next_id, is_default, created_at, updated_at`,
          [userId, body.name, body.colOverride, JSON.stringify(body.layouts), JSON.stringify(body.components), body.nextId, body.isDefault]
        );

        await client.query('COMMIT');

        return reply.status(201).send({
          success: true,
          data: formatLayout(result.rows[0]),
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
          error: { code: 'DUPLICATE_DASHBOARD_NAME', message: 'A dashboard with that name already exists' },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      throw error;
    }
  });

  // PUT /:id  — update a dashboard
  fastify.put('/:id', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const { id } = request.params as { id: string };
    const layoutId = parseInt(id);

    if (isNaN(layoutId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_ID', message: 'Layout ID must be a number' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    let body;
    try {
      body = UpdateDashboardSchema.parse(request.body);
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

    // Build dynamic SET clause
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (body.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(body.name);
    }
    if (body.colOverride !== undefined) {
      setClauses.push(`col_override = $${paramIndex++}`);
      values.push(body.colOverride);
    }
    if (body.layouts !== undefined) {
      setClauses.push(`layouts = $${paramIndex++}`);
      values.push(JSON.stringify(body.layouts));
    }
    if (body.components !== undefined) {
      setClauses.push(`components = $${paramIndex++}`);
      values.push(JSON.stringify(body.components));
    }
    if (body.nextId !== undefined) {
      setClauses.push(`next_id = $${paramIndex++}`);
      values.push(body.nextId);
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

        // Ownership check
        const check = await client.query(
          'SELECT user_id FROM dashboard_layouts WHERE id = $1',
          [layoutId]
        );
        if (check.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Dashboard layout not found' },
            meta: { timestamp: new Date().toISOString() },
          });
        }
        if (check.rows[0].user_id !== userId) {
          await client.query('ROLLBACK');
          return reply.status(403).send({
            success: false,
            error: { code: 'FORBIDDEN', message: 'You do not own this dashboard layout' },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        if (body.isDefault === true) {
          await client.query(
            'UPDATE dashboard_layouts SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE AND id != $2',
            [userId, layoutId]
          );
        }

        values.push(layoutId);
        values.push(userId);
        const result = await client.query(
          `UPDATE dashboard_layouts
           SET ${setClauses.join(', ')}
           WHERE id = $${paramIndex++} AND user_id = $${paramIndex}
           RETURNING id, name, col_override, layouts, components, next_id, is_default, created_at, updated_at`,
          values
        );

        await client.query('COMMIT');

        return reply.send({
          success: true,
          data: formatLayout(result.rows[0]),
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
          error: { code: 'DUPLICATE_DASHBOARD_NAME', message: 'A dashboard with that name already exists' },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      throw error;
    }
  });

  // DELETE /:id  — delete a dashboard
  fastify.delete('/:id', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const { id } = request.params as { id: string };
    const layoutId = parseInt(id);

    if (isNaN(layoutId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_ID', message: 'Layout ID must be a number' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const result = await pool.query(
      'DELETE FROM dashboard_layouts WHERE id = $1 AND user_id = $2 RETURNING id',
      [layoutId, userId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Dashboard layout not found or not owned by you' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    return reply.send({
      success: true,
      data: { message: 'Dashboard deleted' },
      meta: { timestamp: new Date().toISOString() },
    });
  });
}
