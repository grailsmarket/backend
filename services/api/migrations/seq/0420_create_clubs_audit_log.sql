-- Migration: Create clubs audit log for cat-admin tracking
-- Description: Tracks all changes to clubs and club_memberships tables with actor wallet address
-- Date: 2025-02-02

-- ============================================================================
-- STEP 1: Create clubs_audit_log table
-- ============================================================================
CREATE TABLE clubs_audit_log (
  id SERIAL PRIMARY KEY,

  -- What changed
  table_name VARCHAR(50) NOT NULL,        -- 'clubs' or 'club_memberships'
  operation VARCHAR(10) NOT NULL,         -- 'INSERT', 'UPDATE', 'DELETE'
  record_key TEXT NOT NULL,               -- clubs.name or 'club_name:ens_name'

  -- Change details
  old_data JSONB,                         -- Previous values (NULL for INSERT)
  new_data JSONB,                         -- New values (NULL for DELETE)

  -- Who made the change
  actor_address VARCHAR(42),              -- Wallet address (from session var)
  db_user VARCHAR(63) NOT NULL,           -- PostgreSQL user (current_user)

  -- When
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE clubs_audit_log IS 'Audit log tracking all changes to clubs and club_memberships tables';
COMMENT ON COLUMN clubs_audit_log.actor_address IS 'Wallet address that initiated the change (set via app.actor_address session variable)';
COMMENT ON COLUMN clubs_audit_log.db_user IS 'PostgreSQL database user that executed the change';
COMMENT ON COLUMN clubs_audit_log.record_key IS 'Primary key of affected record: club name or club_name:ens_name';

-- ============================================================================
-- STEP 2: Create indexes for querying audit log
-- ============================================================================
CREATE INDEX idx_clubs_audit_actor ON clubs_audit_log(actor_address);
CREATE INDEX idx_clubs_audit_created ON clubs_audit_log(created_at DESC);
CREATE INDEX idx_clubs_audit_table_op ON clubs_audit_log(table_name, operation);
CREATE INDEX idx_clubs_audit_record_key ON clubs_audit_log(record_key);

-- ============================================================================
-- STEP 3: Create audit trigger function
-- ============================================================================
CREATE OR REPLACE FUNCTION clubs_audit_trigger()
RETURNS TRIGGER AS $$
DECLARE
  actor VARCHAR(42);
  record_key TEXT;
  old_json JSONB;
  new_json JSONB;
BEGIN
  -- Get actor address from session variable (set by cat-admin before transactions)
  -- Using 'true' as second parameter makes it return NULL if not set instead of error
  actor := current_setting('app.actor_address', true);

  -- Determine record key based on table
  IF TG_TABLE_NAME = 'clubs' THEN
    record_key := COALESCE(NEW.name, OLD.name);
  ELSIF TG_TABLE_NAME = 'club_memberships' THEN
    record_key := COALESCE(NEW.club_name, OLD.club_name) || ':' || COALESCE(NEW.ens_name, OLD.ens_name);
  END IF;

  -- Build JSON representations
  IF TG_OP = 'DELETE' THEN
    old_json := to_jsonb(OLD);
    new_json := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    old_json := NULL;
    new_json := to_jsonb(NEW);
  ELSE -- UPDATE
    old_json := to_jsonb(OLD);
    new_json := to_jsonb(NEW);
  END IF;

  -- Insert audit record
  INSERT INTO clubs_audit_log (table_name, operation, record_key, old_data, new_data, actor_address, db_user)
  VALUES (TG_TABLE_NAME, TG_OP, record_key, old_json, new_json, actor, current_user);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION clubs_audit_trigger() IS 'Audit trigger that logs all changes to clubs tables with actor wallet address';

-- ============================================================================
-- STEP 4: Attach triggers to clubs and club_memberships tables
-- ============================================================================

-- Audit trigger on clubs table (INSERT, UPDATE, DELETE)
CREATE TRIGGER clubs_audit
  AFTER INSERT OR UPDATE OR DELETE ON clubs
  FOR EACH ROW EXECUTE FUNCTION clubs_audit_trigger();

-- Audit trigger on club_memberships table (INSERT, DELETE only - no UPDATE expected)
CREATE TRIGGER club_memberships_audit
  AFTER INSERT OR DELETE ON club_memberships
  FOR EACH ROW EXECUTE FUNCTION clubs_audit_trigger();

-- ============================================================================
-- STEP 5: Grant permissions to grails_cat_admin user
-- ============================================================================
-- Note: The grails_cat_admin user must be created separately with appropriate
-- permissions on clubs and club_memberships tables. These grants allow the
-- audit trigger to insert records when grails_cat_admin makes changes.

DO $$
BEGIN
  -- Only grant if the user exists
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grails_cat_admin') THEN
    GRANT INSERT ON clubs_audit_log TO grails_cat_admin;
    GRANT USAGE, SELECT ON SEQUENCE clubs_audit_log_id_seq TO grails_cat_admin;
  END IF;
END $$;
