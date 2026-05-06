import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { getPostgresPool } from '../../../shared/src';
import { requireAuth, requireMinTier, optionalAuth } from '../middleware/auth';
import { getViewerIdentifier } from '../services/name-views';
import { trackDashboardView } from '../services/dashboard-views';

const MAX_DASHBOARDS_PER_USER = 10;
const MAX_WIDGETS_PER_DASHBOARD = 20;

// --- Widget type enum (matches frontend DashboardComponentType) ---

const WidgetType = z.enum([
  'domains',
  'ai-search',
  'top-sales',
  'top-offers',
  'top-registrations',
  'sales-chart',
  'offers-chart',
  'registrations-chart',
  'holders',
  'leaderboard',
  'activity',
  'name-view',
  'profile-view',
  'watchlist',
  'category-holders',
  'category-stats',
  'portfolio-summary',
  'expiring-domains',
  'recent-sales',
  'recent-premium',
  'recent-registrations',
  'twitter-feed',
]);

// --- Per-type config schemas (matches frontend instance configs) ---

const AnalyticsPeriod = z.enum(['24h', '7d', '30d', '1y', 'all']);
const AnalyticsSource = z.enum(['all', 'grails', 'opensea']);

// `domains` and `ai-search` share this shape; only their default filters differ.
const DomainsConfig = z.object({
  type: z.enum(['domains', 'ai-search']),
  name: z.string().default(''),
  viewType: z.enum(['grid', 'list']),
  filters: z.record(z.unknown()), // MarketplaceFiltersState is complex; store as-is
  filtersOpen: z.boolean(),
});

const AnalyticsListConfig = z.object({
  type: z.enum(['top-sales', 'top-offers', 'top-registrations']),
  name: z.string().default(''),
  period: AnalyticsPeriod,
  source: AnalyticsSource,
  category: z.string().nullable(),
});

const AnalyticsChartConfig = z.object({
  type: z.enum(['sales-chart', 'offers-chart', 'registrations-chart']),
  name: z.string().default(''),
  period: AnalyticsPeriod,
  category: z.string().nullable(),
});

const HoldersConfig = z.object({
  type: z.literal('holders'),
  name: z.string().default(''),
  categories: z.array(z.string()),
});

const LeaderboardConfig = z.object({
  type: z.literal('leaderboard'),
  name: z.string().default(''),
  sortBy: z.enum(['names_owned', 'names_in_clubs', 'expired_names', 'names_listed', 'names_sold', 'sales_volume']),
  sortOrder: z.enum(['asc', 'desc']),
  clubs: z.array(z.string()),
});

const ActivityConfig = z.object({
  type: z.literal('activity'),
  name: z.string().default(''),
  eventTypes: z.array(z.string()),
  category: z.string().nullable(),
});

const NameViewConfig = z.object({
  type: z.literal('name-view'),
  name: z.string().default(''),
  query: z.string(),
  submittedName: z.string().nullable(),
});

const ProfileViewConfig = z.object({
  type: z.literal('profile-view'),
  name: z.string().default(''),
  query: z.string(),
  submittedUser: z.string().nullable(),
});

const WatchlistWidgetConfig = z.object({
  type: z.literal('watchlist'),
  name: z.string().default(''),
  viewType: z.enum(['grid', 'list']),
});

const CategoryHoldersConfig = z.object({
  type: z.literal('category-holders'),
  name: z.string().default(''),
  category: z.string().nullable(),
});

const CategoryStatsConfig = z.object({
  type: z.literal('category-stats'),
  name: z.string().default(''),
  category: z.string().nullable(),
});

const PortfolioSummaryConfig = z.object({
  type: z.literal('portfolio-summary'),
  name: z.string().default(''),
});

const ExpiringDomainsConfig = z.object({
  type: z.literal('expiring-domains'),
  name: z.string().default(''),
});

const RecentConfig = z.object({
  type: z.enum(['recent-sales', 'recent-premium', 'recent-registrations']),
  name: z.string().default(''),
});

const TwitterFeedConfig = z.object({
  type: z.literal('twitter-feed'),
  name: z.string().default(''),
  handle: z.string(),
});

const ComponentConfig = z.discriminatedUnion('type', [
  DomainsConfig,
  AnalyticsListConfig,
  AnalyticsChartConfig,
  HoldersConfig,
  LeaderboardConfig,
  ActivityConfig,
  NameViewConfig,
  ProfileViewConfig,
  WatchlistWidgetConfig,
  CategoryHoldersConfig,
  CategoryStatsConfig,
  PortfolioSummaryConfig,
  ExpiringDomainsConfig,
  RecentConfig,
  TwitterFeedConfig,
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
  isPublic: z.boolean().optional(),
});

// base64url alphabet is URL-safe, no padding at 10 chars
function generatePublicSlug(): string {
  return crypto.randomBytes(8).toString('base64url').slice(0, 10);
}

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
    isPublic: row.is_public,
    publicSlug: row.public_slug,
    publishedAt: row.published_at,
    viewCount: row.view_count,
    forkCount: row.fork_count,
    forkedFromId: row.forked_from_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Public view shape — omits owner-only fields like is_default
function formatPublicLayout(row: any) {
  return {
    id: row.id,
    name: row.name,
    colOverride: row.col_override,
    layouts: row.layouts,
    components: row.components,
    nextId: row.next_id,
    publicSlug: row.public_slug,
    publishedAt: row.published_at,
    viewCount: row.view_count,
    forkCount: row.fork_count,
    forkedFromId: row.forked_from_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: {
      address: row.owner_address,
    },
  };
}

const LAYOUT_COLUMNS = `id, name, col_override, layouts, components, next_id, is_default,
  is_public, public_slug, published_at, view_count, fork_count, forked_from_id,
  created_at, updated_at`;

// --- Routes ---

export async function dashboardLayoutsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const preHandler = [requireAuth, requireMinTier('plus')];

  // GET /  — list all dashboards for the authenticated user
  fastify.get('/', { preHandler }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);

    const result = await pool.query(
      `SELECT ${LAYOUT_COLUMNS}
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
      `SELECT user_id, ${LAYOUT_COLUMNS}
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
           RETURNING ${LAYOUT_COLUMNS}`,
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

    if (setClauses.length === 0 && body.isPublic === undefined) {
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

        // Ownership check + pull current slug so we know whether we need to mint one
        const check = await client.query(
          'SELECT user_id, public_slug FROM dashboard_layouts WHERE id = $1',
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

        // Visibility toggle: publish mints a slug (once) and sets published_at;
        // unpublish leaves slug intact so the share URL is stable on republish.
        if (body.isPublic !== undefined) {
          setClauses.push(`is_public = $${paramIndex++}`);
          values.push(body.isPublic);

          if (body.isPublic === true && !check.rows[0].public_slug) {
            let slug = generatePublicSlug();
            for (let attempt = 0; attempt < 3; attempt++) {
              const collision = await client.query(
                'SELECT 1 FROM dashboard_layouts WHERE public_slug = $1',
                [slug]
              );
              if (collision.rows.length === 0) break;
              slug = generatePublicSlug();
            }
            setClauses.push(`public_slug = $${paramIndex++}`);
            values.push(slug);
            setClauses.push(`published_at = COALESCE(published_at, NOW())`);
          }
        }

        values.push(layoutId);
        values.push(userId);
        const result = await client.query(
          `UPDATE dashboard_layouts
           SET ${setClauses.join(', ')}
           WHERE id = $${paramIndex++} AND user_id = $${paramIndex}
           RETURNING ${LAYOUT_COLUMNS}`,
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

  // GET /public/:slug  — fetch a published dashboard by share slug (no auth required)
  fastify.get('/public/:slug', { preHandler: [optionalAuth] }, async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const result = await pool.query(
      `SELECT d.user_id, ${LAYOUT_COLUMNS.split(',').map((c) => `d.${c.trim()}`).join(', ')},
              u.address AS owner_address
       FROM dashboard_layouts d
       JOIN users u ON u.id = d.user_id
       WHERE d.public_slug = $1 AND d.is_public = TRUE`,
      [slug]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Dashboard not found or no longer public' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const row = result.rows[0];

    // Fire-and-forget view tracking; owner self-views are skipped inside the service.
    const viewer = getViewerIdentifier(request);
    trackDashboardView(row.id, viewer.identifier, viewer.type, row.user_id).catch(() => {
      // swallowed — tracking must never break the request
    });

    return reply.send({
      success: true,
      data: formatPublicLayout(row),
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /public/:slug/fork  — copy a public dashboard into forker's collection
  fastify.post(
    '/public/:slug/fork',
    { preHandler: [requireAuth, requireMinTier('plus')] },
    async (request, reply) => {
      const forkerId = parseInt(request.user!.sub);
      const { slug } = request.params as { slug: string };

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sourceResult = await client.query(
          `SELECT id, user_id, name, col_override, layouts, components, next_id
           FROM dashboard_layouts
           WHERE public_slug = $1 AND is_public = TRUE`,
          [slug]
        );

        if (sourceResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Dashboard not found or no longer public' },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        const source = sourceResult.rows[0];

        if (source.user_id === forkerId) {
          await client.query('ROLLBACK');
          return reply.status(409).send({
            success: false,
            error: { code: 'CANNOT_FORK_OWN', message: 'You cannot fork your own dashboard' },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        const countResult = await client.query(
          'SELECT COUNT(*)::int AS count FROM dashboard_layouts WHERE user_id = $1',
          [forkerId]
        );
        if (countResult.rows[0].count >= MAX_DASHBOARDS_PER_USER) {
          await client.query('ROLLBACK');
          return reply.status(400).send({
            success: false,
            error: {
              code: 'LIMIT_EXCEEDED',
              message: `Maximum of ${MAX_DASHBOARDS_PER_USER} dashboards allowed`,
            },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        // Pick a non-colliding name: "<source.name> (forked)", "(forked 2)", …
        const baseName = `${source.name} (forked)`.slice(0, 100);
        let forkName = baseName;
        for (let attempt = 2; attempt <= 10; attempt++) {
          const exists = await client.query(
            'SELECT 1 FROM dashboard_layouts WHERE user_id = $1 AND name = $2',
            [forkerId, forkName]
          );
          if (exists.rows.length === 0) break;
          const suffix = ` (forked ${attempt})`;
          forkName = `${source.name.slice(0, 100 - suffix.length)}${suffix}`;
        }

        const insertResult = await client.query(
          `INSERT INTO dashboard_layouts
             (user_id, name, col_override, layouts, components, next_id,
              is_default, is_public, forked_from_id)
           VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE, $7)
           RETURNING ${LAYOUT_COLUMNS}`,
          [
            forkerId,
            forkName,
            source.col_override,
            JSON.stringify(source.layouts),
            JSON.stringify(source.components),
            source.next_id,
            source.id,
          ]
        );

        const newDashboard = insertResult.rows[0];

        // Audit row — trigger bumps source.fork_count
        await client.query(
          `INSERT INTO dashboard_forks (parent_dashboard_id, child_dashboard_id, forker_user_id)
           VALUES ($1, $2, $3)`,
          [source.id, newDashboard.id, forkerId]
        );

        await client.query('COMMIT');

        return reply.status(201).send({
          success: true,
          data: formatLayout(newDashboard),
          meta: { timestamp: new Date().toISOString() },
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );
}
