-- Fix NULL order_hash values in offers table
-- Migration: fix_null_order_hashes
-- Created: 2025-10-03

-- Update NULL order_hash values with a unique placeholder based on offer ID
-- This allows the ON CONFLICT (order_hash, source) to work properly
UPDATE offers
SET order_hash = 'placeholder_' || id || '_' || source
WHERE order_hash IS NULL;

-- Verify the fix
DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count FROM offers WHERE order_hash IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'Still have % NULL order_hash values', null_count;
  ELSE
    RAISE NOTICE 'All order_hash values updated successfully. Zero NULL values remain.';
  END IF;
END $$;
