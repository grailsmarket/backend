-- Add last_sale_date to ens_names table
-- Migration: add_last_sale_date
-- Created: 2025-10-21
-- IMPORTANT: This migration depends on the sales table existing. Run create_sales_table.sql first.

-- Add last_sale_date column to ens_names
ALTER TABLE ens_names
ADD COLUMN IF NOT EXISTS last_sale_date TIMESTAMP DEFAULT NULL;

-- Create index for performance (partial index - only on names with sales)
CREATE INDEX IF NOT EXISTS idx_ens_names_last_sale_date
ON ens_names(last_sale_date DESC)
WHERE last_sale_date IS NOT NULL;

-- Add comment
COMMENT ON COLUMN ens_names.last_sale_date IS 'Timestamp of the most recent sale for this ENS name (denormalized from sales table)';

-- Backfill last_sale_date from existing sales data
UPDATE ens_names en
SET last_sale_date = (
    SELECT MAX(sale_date)
    FROM sales s
    WHERE s.ens_name_id = en.id
)
WHERE EXISTS (
    SELECT 1 FROM sales s WHERE s.ens_name_id = en.id
);

-- Create trigger function to automatically update last_sale_date when new sale is recorded
CREATE OR REPLACE FUNCTION update_ens_name_last_sale_date()
RETURNS TRIGGER AS $$
BEGIN
    -- Update the ens_names table with the new sale date if it's more recent
    UPDATE ens_names
    SET
        last_sale_date = NEW.sale_date,
        updated_at = NOW()
    WHERE id = NEW.ens_name_id
      AND (last_sale_date IS NULL OR NEW.sale_date > last_sale_date);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update last_sale_date on new sales
DROP TRIGGER IF EXISTS update_last_sale_date_on_sale ON sales;
CREATE TRIGGER update_last_sale_date_on_sale
    AFTER INSERT ON sales
    FOR EACH ROW
    EXECUTE FUNCTION update_ens_name_last_sale_date();

-- Verify the migration
DO $$
DECLARE
    sale_count INTEGER;
    updated_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO sale_count FROM sales;
    SELECT COUNT(*) INTO updated_count FROM ens_names WHERE last_sale_date IS NOT NULL;

    RAISE NOTICE 'Migration completed:';
    RAISE NOTICE '  - Total sales in database: %', sale_count;
    RAISE NOTICE '  - ENS names with last_sale_date: %', updated_count;
    RAISE NOTICE '  - Trigger created: update_last_sale_date_on_sale';
END $$;
