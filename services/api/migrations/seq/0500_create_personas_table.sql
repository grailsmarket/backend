-- Migration: 0500_create_personas_table
-- Description: Create personas table for user behavioral classification
-- and add persona columns to users table

CREATE TABLE personas (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    priority INTEGER NOT NULL DEFAULT 0,
    criteria JSONB NOT NULL DEFAULT '{}',
    default_filters_all_names JSONB NOT NULL DEFAULT '{}',
    default_filters_listings JSONB NOT NULL DEFAULT '{}',
    default_filters_sales JSONB NOT NULL DEFAULT '{}',
    default_filters_registrations JSONB NOT NULL DEFAULT '{}',
    default_filters_offers JSONB NOT NULL DEFAULT '{}',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN persona_classified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN persona_scores JSONB;

CREATE INDEX idx_users_persona_id ON users(persona_id);
