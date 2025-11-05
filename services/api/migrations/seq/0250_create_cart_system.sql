-- Migration: Create Cart System
-- Description: Creates cart_types and cart_items tables to support user cart/basket functionality
-- Date: 2025-01-04

-- Create cart_types table
-- This table defines the different types of carts/baskets users can have
CREATE TABLE IF NOT EXISTS cart_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create cart_items table
-- This table stores the actual items in user carts
CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  cart_type_id INTEGER NOT NULL REFERENCES cart_types(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Ensure a user can't add the same ENS name to the same cart type multiple times
  CONSTRAINT cart_items_user_ens_cart_unique UNIQUE (user_id, ens_name_id, cart_type_id)
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_cart_items_user_id ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_ens_name_id ON cart_items(ens_name_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_type_id ON cart_items(cart_type_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_user_cart_type ON cart_items(user_id, cart_type_id);

-- Insert initial cart types
INSERT INTO cart_types (name, description) VALUES
  ('sales', 'ENS names the user is interested in purchasing'),
  ('registrations', 'ENS names the user wants to register')
ON CONFLICT (name) DO NOTHING;

-- Create trigger to automatically update updated_at timestamp for cart_types
CREATE OR REPLACE FUNCTION update_cart_types_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cart_types_updated_at_trigger') THEN
    CREATE TRIGGER cart_types_updated_at_trigger
    BEFORE UPDATE ON cart_types
    FOR EACH ROW
    EXECUTE FUNCTION update_cart_types_updated_at();
  END IF;
END $$;

-- Create trigger to automatically update updated_at timestamp for cart_items
CREATE OR REPLACE FUNCTION update_cart_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cart_items_updated_at_trigger') THEN
    CREATE TRIGGER cart_items_updated_at_trigger
    BEFORE UPDATE ON cart_items
    FOR EACH ROW
    EXECUTE FUNCTION update_cart_items_updated_at();
  END IF;
END $$;
