import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool } from '../../../shared/src';
import { requireAuth, requireMinTier } from '../middleware/auth';

const MAX_DASHBOARDS_PER_USER = 10;
const MAX_PANELS_PER_DASHBOARD = 20;

// --- Panel type enum ---

const PanelType = z.enum([
  'registrations_chart',
  'sales_chart',
  'top_registrations',
  'domains',
  'top_sales',
  'activity',
]);

// --- Per-type config schemas ---

const ChartPanelConfig = z.object({
  defaultPeriod: z.enum(['1d', '7d', '30d']).default('7d'),
});

const RankedListPanelConfig = z.object({
  defaultPeriod: z.enum(['1d', '7d', '30d']).default('7d'),
  defaultMarketSource: z.enum(['all', 'grails', 'opensea']).default('all'),
});

const DomainsPanelConfig = z.object({
  defaultCategory: z.string().max(50).optional(),
});

const ActivityPanelConfig = z.object({
  defaultEventTypes: z.array(
    z.enum(['sale', 'listing', 'offer', 'registration', 'renewal', 'transfer'])
  ).optional(),
});

// --- Panel schema with per-type config validation ---

const PanelSchema = z.object({
  id: z.string().min(1).max(50),
  panelType: PanelType,
  x: z.number().int().min(0).max(3),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(4),
  h: z.number().int().min(1).max(4),
  config: z.record(z.unknown()).optional(),
}).superRefine((panel, ctx) => {
  if (panel.x + panel.w > 4) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Panel extends beyond grid boundary (x + w must be <= 4)',
      path: ['w'],
    });
  }

  if (panel.config) {
    let configResult;
    switch (panel.panelType) {
      case 'registrations_chart':
      case 'sales_chart':
        configResult = ChartPanelConfig.safeParse(panel.config);
        break;
      case 'top_registrations':
      case 'top_sales':
        configResult = RankedListPanelConfig.safeParse(panel.config);
        break;
      case 'domains':
        configResult = DomainsPanelConfig.safeParse(panel.config);
        break;
      case 'activity':
        configResult = ActivityPanelConfig.safeParse(panel.config);
        break;
    }
    if (configResult && !configResult.success) {
      configResult.error.issues.forEach(issue => {
        ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
      });
    }
  }
});

// --- Dashboard schemas ---

const CreateDashboardSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  gridColumns: z.enum(['auto', '1', '2', '3', '4']).default('auto'),
  panels: z.array(PanelSchema).max(MAX_PANELS_PER_DASHBOARD).default([]).refine(
    (panels) => {
      const ids = panels.map(p => p.id);
      return new Set(ids).size === ids.length;
    },
    { message: 'Panel IDs must be unique within a dashboard' }
  ),
  isDefault: z.boolean().default(false),
});

const UpdateDashboardSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  gridColumns: z.enum(['auto', '1', '2', '3', '4']).optional(),
  panels: z.array(PanelSchema).max(MAX_PANELS_PER_DASHBOARD).optional().refine(
    (panels) => {
      if (!panels) return true;
      const ids = panels.map(p => p.id);
      return new Set(ids).size === ids.length;
    },
    { message: 'Panel IDs must be unique within a dashboard' }
  ),
  isDefault: z.boolean().optional(),
});

// --- Default layout template (returned when user has no saved dashboards) ---

const DEFAULT_LAYOUT_TEMPLATE = {
  name: 'Default',
  gridColumns: 'auto',
  panels: [
    { id: 'default-reg-chart', panelType: 'registrations_chart', x: 0, y: 0, w: 1, h: 2, config: { defaultPeriod: '7d' } },
    { id: 'default-sales-chart', panelType: 'sales_chart', x: 1, y: 0, w: 1, h: 2, config: { defaultPeriod: '7d' } },
    { id: 'default-top-reg', panelType: 'top_registrations', x: 2, y: 0, w: 1, h: 2, config: { defaultPeriod: '7d', defaultMarketSource: 'all' } },
    { id: 'default-domains', panelType: 'domains', x: 0, y: 2, w: 3, h: 2, config: {} },
    { id: 'default-top-sales', panelType: 'top_sales', x: 3, y: 0, w: 1, h: 2, config: { defaultPeriod: '7d', defaultMarketSource: 'all' } },
    { id: 'default-activity', panelType: 'activity', x: 3, y: 2, w: 1, h: 2, config: {} },
  ],
};

// --- Helper to map DB rows to API response format ---

function formatLayout(row: any) {
  return {
    id: row.id,
    name: row.name,
    gridColumns: row.grid_columns,
    panels: row.panels,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Routes ---

export async function dashboardLayoutsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const preHandler = [requireAuth, requireMinTier('pro')];

  // GET /  — list all dashboards for the authenticated user
  fastify.get('/', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);

    const result = await pool.query(
      `SELECT id, name, grid_columns, panels, is_default, created_at, updated_at
       FROM dashboard_layouts
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at ASC`,
      [userId]
    );

    return reply.send({
      success: true,
      data: {
        layouts: result.rows.map(formatLayout),
        defaultTemplate: DEFAULT_LAYOUT_TEMPLATE,
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
      `SELECT id, user_id, name, grid_columns, panels, is_default, created_at, updated_at
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

        // Clear existing default if setting this one as default
        if (body.isDefault) {
          await client.query(
            'UPDATE dashboard_layouts SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE',
            [userId]
          );
        }

        const result = await client.query(
          `INSERT INTO dashboard_layouts (user_id, name, grid_columns, panels, is_default)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, grid_columns, panels, is_default, created_at, updated_at`,
          [userId, body.name, body.gridColumns, JSON.stringify(body.panels), body.isDefault]
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
    if (body.gridColumns !== undefined) {
      setClauses.push(`grid_columns = $${paramIndex++}`);
      values.push(body.gridColumns);
    }
    if (body.panels !== undefined) {
      setClauses.push(`panels = $${paramIndex++}`);
      values.push(JSON.stringify(body.panels));
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

        // Clear existing default if setting this one as default
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
           RETURNING id, name, grid_columns, panels, is_default, created_at, updated_at`,
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
