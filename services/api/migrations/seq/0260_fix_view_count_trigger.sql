-- Migration: Fix view_count trigger to update updated_at timestamp
-- Description: Ensures view_count increments trigger WAL listener sync to Elasticsearch
-- Date: 2025-01-04

-- Drop and recreate the trigger function to include updated_at
CREATE OR REPLACE FUNCTION increment_name_view_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ens_names
  SET view_count = view_count + 1,
      updated_at = NOW()
  WHERE id = NEW.ens_name_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- No need to recreate the trigger itself, just the function
-- The trigger after_name_view_insert will now use the updated function
