-- Reshape dashboard_layouts to match frontend DashboardState:
--   layouts: per-breakpoint position arrays (react-grid-layout)
--   components: widget instance configs keyed by ID
--   col_override: nullable integer (null = auto responsive)
--   next_id: widget ID counter

ALTER TABLE dashboard_layouts DROP CONSTRAINT valid_grid_columns;
ALTER TABLE dashboard_layouts DROP COLUMN grid_columns;
ALTER TABLE dashboard_layouts DROP COLUMN panels;

ALTER TABLE dashboard_layouts ADD COLUMN col_override INTEGER;
ALTER TABLE dashboard_layouts ADD COLUMN layouts JSONB NOT NULL DEFAULT '{"lg":[],"md":[],"sm":[],"xs":[]}';
ALTER TABLE dashboard_layouts ADD COLUMN components JSONB NOT NULL DEFAULT '{}';
ALTER TABLE dashboard_layouts ADD COLUMN next_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE dashboard_layouts ADD CONSTRAINT valid_col_override
  CHECK (col_override IS NULL OR col_override BETWEEN 1 AND 4);
