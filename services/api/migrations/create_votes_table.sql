-- Create name_votes table for upvote/downvote functionality
-- Migration: create_votes_table
-- Created: 2025-10-19

CREATE TABLE name_votes (
  id SERIAL PRIMARY KEY,
  ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote SMALLINT NOT NULL CHECK (vote IN (-1, 0, 1)),  -- -1 = downvote, 0 = neutral/removed, 1 = upvote
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Ensure one vote per user per name
  UNIQUE(ens_name_id, user_id)
);

-- Indexes for performance
CREATE INDEX idx_name_votes_ens_name_id ON name_votes(ens_name_id);
CREATE INDEX idx_name_votes_user_id ON name_votes(user_id);
CREATE INDEX idx_name_votes_vote ON name_votes(vote) WHERE vote != 0;

-- Trigger to auto-update updated_at
CREATE TRIGGER update_name_votes_updated_at
  BEFORE UPDATE ON name_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add denormalized vote count columns to ens_names for performance
ALTER TABLE ens_names
  ADD COLUMN IF NOT EXISTS upvotes INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS downvotes INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_score INTEGER DEFAULT 0;

-- Create indexes on vote columns for sorting/filtering
CREATE INDEX idx_ens_names_upvotes ON ens_names(upvotes DESC);
CREATE INDEX idx_ens_names_net_score ON ens_names(net_score DESC);

-- Function to update vote counts on ens_names
CREATE OR REPLACE FUNCTION update_ens_name_vote_counts()
RETURNS TRIGGER AS $$
BEGIN
  -- If this is an INSERT or UPDATE, recalculate for the affected name
  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
    UPDATE ens_names
    SET
      upvotes = (SELECT COUNT(*) FROM name_votes WHERE ens_name_id = NEW.ens_name_id AND vote = 1),
      downvotes = (SELECT COUNT(*) FROM name_votes WHERE ens_name_id = NEW.ens_name_id AND vote = -1),
      net_score = (SELECT COALESCE(SUM(vote), 0) FROM name_votes WHERE ens_name_id = NEW.ens_name_id)
    WHERE id = NEW.ens_name_id;
    RETURN NEW;
  END IF;

  -- If this is a DELETE, recalculate for the old name
  IF (TG_OP = 'DELETE') THEN
    UPDATE ens_names
    SET
      upvotes = (SELECT COUNT(*) FROM name_votes WHERE ens_name_id = OLD.ens_name_id AND vote = 1),
      downvotes = (SELECT COUNT(*) FROM name_votes WHERE ens_name_id = OLD.ens_name_id AND vote = -1),
      net_score = (SELECT COALESCE(SUM(vote), 0) FROM name_votes WHERE ens_name_id = OLD.ens_name_id)
    WHERE id = OLD.ens_name_id;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update denormalized counts
CREATE TRIGGER trigger_update_vote_counts
  AFTER INSERT OR UPDATE OR DELETE ON name_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_ens_name_vote_counts();

-- Comments
COMMENT ON TABLE name_votes IS 'Stores user votes (upvote/downvote) for ENS names';
COMMENT ON COLUMN name_votes.vote IS 'Vote value: 1 = upvote, -1 = downvote, 0 = neutral/removed';
COMMENT ON COLUMN ens_names.upvotes IS 'Denormalized count of upvotes (vote = 1)';
COMMENT ON COLUMN ens_names.downvotes IS 'Denormalized count of downvotes (vote = -1)';
COMMENT ON COLUMN ens_names.net_score IS 'Denormalized net score (sum of all votes)';
