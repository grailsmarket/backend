-- SQL Query to Export ENS Names from Subgraph for Import into Grails
--
-- This query maps the subgraph 'domains' table to the Grails ens_names table format
-- Run this in your subgraph database query browser and export as CSV
--
-- Usage: Copy the result and import into ens_names table using ON CONFLICT DO NOTHING

-- Helper function to convert hex to decimal (for 256-bit numbers)
-- Note: This might need to be created in your database first if it doesn't exist
-- CREATE OR REPLACE FUNCTION hex_to_numeric(hex_str text) RETURNS numeric AS $$
--   SELECT ('x' || lpad(CASE WHEN hex_str LIKE '0x%' THEN substring(hex_str from 3) ELSE hex_str END, 64, '0'))::bit(256)::bigint;
-- $$ LANGUAGE SQL IMMUTABLE;

SELECT
    -- Convert 256-bit hex to decimal by processing each hex digit
    -- Use id for wrapped names, labelhash for unwrapped names
    -- Sum up: digit_value * 16^position for each hex digit
    TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM (
        SELECT SUM(
            CASE
                WHEN digit >= '0' AND digit <= '9' THEN (ascii(digit) - ascii('0'))::numeric
                WHEN digit >= 'a' AND digit <= 'f' THEN (ascii(digit) - ascii('a') + 10)::numeric
                WHEN digit >= 'A' AND digit <= 'F' THEN (ascii(digit) - ascii('A') + 10)::numeric
            END * (16::numeric ^ (64 - pos))
        )
        FROM (
            SELECT
                substring(substring(
                    CASE
                        WHEN d.wrapped_owner_id IS NOT NULL THEN d.id
                        ELSE d.labelhash
                    END
                from 3), pos, 1) as digit,
                pos
            FROM generate_series(1, 64) as pos
        ) digits
    )::text)) as token_id,

    -- ENS name (already formatted as name.eth)
    d.name as name,

    -- Label name (without .eth suffix)
    d.label_name as label_name,

    -- Owner address (current owner)
    COALESCE(d.wrapped_owner_id, d.owner_id) as owner_address,

    -- Registrant (the account that registered it, can be different from owner)
    d.registrant_id as registrant,

    -- Expiry date (unix timestamp to timestamp)
    to_timestamp(d.expiry_date) as expiry_date,

    -- Registration date (unix timestamp to timestamp)
    to_timestamp(d.created_at) as registration_date,

    -- Last transfer date - we don't have this in subgraph, use NULL
    NULL::timestamp as last_transfer_date,

    -- Metadata - empty JSON object
    '{}'::jsonb as metadata,

    -- Resolver address - extract from resolver_id if it exists
    -- Format: "1-0x4976...-0x2be0..." -> extract middle address
    CASE
        WHEN d.resolver_id IS NOT NULL THEN
            SUBSTRING(d.resolver_id FROM '-0x([0-9a-f]{40})-' FOR '#')
        ELSE NULL
    END as resolver_address,

    -- has_emoji - check if label contains emoji (unicode > U+1F600)
    (d.label_name ~ '[😀-🙏🚀-🛿]') as has_emoji,

    -- has_numbers - check if label contains digits
    (d.label_name ~ '[0-9]') as has_numbers,

    -- clubs - NULL for now (will be calculated later)
    NULL::text[] as clubs,

    -- Voting/engagement metrics - default to 0
    0 as upvotes,
    0 as downvotes,
    0 as net_score,

    -- Sales data - NULL for now (will be populated from sales table)
    NULL::timestamp as last_sale_date,
    NULL::varchar(78) as last_sale_price,
    NULL::varchar(42) as last_sale_currency,
    NULL::numeric as last_sale_price_usd,

    -- Offer data - NULL for now (will be populated from offers table)
    NULL::varchar(78) as highest_offer_wei,
    '0x0000000000000000000000000000000000000000'::varchar(42) as highest_offer_currency,
    NULL::integer as highest_offer_id,
    NULL::timestamp as last_offer_update,

    -- View count - default to 0
    0 as view_count,

    -- Timestamps
    NOW() as created_at,
    NOW() as updated_at

FROM domains d
WHERE
    -- Only get .eth names (not subdomains)
    d.parent_id = '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae'

    -- Only get names that are migrated to the new registrar
    AND d.is_migrated = true

ORDER BY d.created_at DESC;

-- Note: After exporting, you can import using these steps:
--
-- Step 1: Create a temp table matching the CSV structure (run once)
-- CREATE TABLE IF NOT EXISTS temp_ens_import (
--     token_id varchar(78) PRIMARY KEY,
--     name text,
--     label_name text,
--     owner_address varchar(42),
--     registrant varchar(42),
--     expiry_date timestamp,
--     registration_date timestamp,
--     last_transfer_date timestamp,
--     metadata jsonb,
--     resolver_address varchar(42),
--     has_emoji boolean,
--     has_numbers boolean,
--     clubs text[],
--     upvotes integer,
--     downvotes integer,
--     net_score integer,
--     last_sale_date timestamp,
--     last_sale_price varchar(78),
--     last_sale_currency varchar(42),
--     last_sale_price_usd numeric,
--     highest_offer_wei varchar(78),
--     highest_offer_currency varchar(42),
--     highest_offer_id integer,
--     last_offer_update timestamp,
--     view_count integer,
--     created_at timestamp,
--     updated_at timestamp
-- );
--
-- Step 2: Import CSV into temp table (run in psql)
-- \copy temp_ens_import FROM 'export.csv' WITH (FORMAT csv, HEADER true, NULL 'NULL');
--
-- Step 3: Insert from temp table into ens_names, excluding label_name column
-- Handle conflicts on both token_id and name constraints
-- INSERT INTO ens_names (token_id, name, owner_address, registrant, expiry_date, registration_date, last_transfer_date, metadata, resolver_address, has_emoji, has_numbers, clubs, upvotes, downvotes, net_score, last_sale_date, last_sale_price, last_sale_currency, last_sale_price_usd, highest_offer_wei, highest_offer_currency, highest_offer_id, last_offer_update, view_count, created_at, updated_at)
-- SELECT token_id, name, owner_address, registrant, expiry_date, registration_date, last_transfer_date, metadata, resolver_address, has_emoji, has_numbers, clubs, upvotes, downvotes, net_score, last_sale_date, last_sale_price, last_sale_currency, last_sale_price_usd, highest_offer_wei, highest_offer_currency, highest_offer_id, last_offer_update, view_count, created_at, updated_at
-- FROM temp_ens_import
-- WHERE NOT EXISTS (
--     SELECT 1 FROM ens_names WHERE ens_names.token_id = temp_ens_import.token_id OR ens_names.name = temp_ens_import.name
-- );
--
-- Step 4: Clean up
-- DROP TABLE temp_ens_import;
