-- Fix pg_notify payload size issue
-- The notify_changes trigger was sending full row data including large order_data fields,
-- which exceeds the 8000 byte limit of pg_notify

CREATE OR REPLACE FUNCTION notify_changes()
RETURNS trigger AS $$
DECLARE
  payload json;
BEGIN
  -- Build a minimal payload with only essential fields
  payload = json_build_object(
    'table', TG_TABLE_NAME,
    'operation', TG_OP,
    'id', COALESCE(NEW.id, OLD.id),
    'timestamp', NOW()
  );

  -- Only notify if payload is reasonably sized (< 7500 bytes to be safe)
  IF length(payload::text) < 7500 THEN
    PERFORM pg_notify('table_changes', payload::text);
  ELSE
    -- Log that we skipped notification due to size
    RAISE NOTICE 'Skipped pg_notify for % operation on % - payload too large', TG_OP, TG_TABLE_NAME;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
