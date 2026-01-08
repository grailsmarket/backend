-- Add 'unfunded' status to listings and offers tables
-- This allows the validation workers to mark listings/offers as unfunded
-- when the seller no longer owns the name or buyer has insufficient balance

-- Add 'unfunded' to listings valid_status constraint
ALTER TABLE listings DROP CONSTRAINT valid_status;
ALTER TABLE listings ADD CONSTRAINT valid_status CHECK (status IN ('active', 'sold', 'cancelled', 'expired', 'unfunded'));

-- Add 'unfunded' to offers valid_status constraint
ALTER TABLE offers DROP CONSTRAINT valid_status;
ALTER TABLE offers ADD CONSTRAINT valid_status CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'unfunded'));
