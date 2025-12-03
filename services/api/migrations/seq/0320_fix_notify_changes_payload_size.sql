-- Fix pg_notify payload size by excluding large JSONB fields
--
-- Problem: The notify_changes() trigger sends full row data via row_to_json(),
-- including large JSONB fields like order_data (~4-5KB) which causes the total
-- payload to exceed pg_notify's 8000 byte limit when both NEW and OLD rows are included.
--
-- Solution: Exclude order_data from listings/offers and metadata from ens_names
-- in the notification payload. These fields are never accessed by the WAL listener
-- which is the only consumer of table_changes notifications.
--
-- Impact: None - WAL listener only uses basic fields like id, status, price_wei, etc.
-- and never accesses order_data or metadata from the notification payload.

CREATE OR REPLACE FUNCTION notify_changes()
RETURNS trigger AS $$
DECLARE
  payload json;
  new_data jsonb;
  old_data jsonb;
BEGIN
  -- Build payload excluding large JSONB columns based on table
  CASE TG_TABLE_NAME
    WHEN 'listings' THEN
      -- Exclude order_data (4-5KB JSONB field)
      new_data = to_jsonb(NEW) - 'order_data';
      old_data = CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) - 'order_data'
        WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - 'order_data'
        ELSE NULL
      END;

    WHEN 'offers' THEN
      -- Exclude order_data (similar to listings)
      new_data = to_jsonb(NEW) - 'order_data';
      old_data = CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) - 'order_data'
        WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - 'order_data'
        ELSE NULL
      END;

    WHEN 'ens_names' THEN
      -- Exclude metadata (can contain large text records)
      new_data = to_jsonb(NEW) - 'metadata';
      old_data = CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) - 'metadata'
        WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - 'metadata'
        ELSE NULL
      END;

    ELSE
      -- For other tables, send full row data
      new_data = to_jsonb(NEW);
      old_data = CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
        WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD)
        ELSE NULL
      END;
  END CASE;

  -- Build the notification payload
  payload = json_build_object(
    'table', TG_TABLE_NAME,
    'operation', TG_OP,
    'data', new_data,
    'old_data', old_data
  );

  -- Send notification
  PERFORM pg_notify('table_changes', payload::text);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add comment documenting the optimization
COMMENT ON FUNCTION notify_changes() IS
'Sends change notifications via pg_notify with large JSONB columns excluded to stay under 8000 byte limit. '
'Excludes: listings.order_data, offers.order_data, ens_names.metadata. '
'These fields are never accessed by the WAL listener notification consumer.';
