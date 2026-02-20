ALTER TABLE club_memberships ADD COLUMN rank INTEGER;
CREATE INDEX idx_club_memberships_rank ON club_memberships (club_name, rank) WHERE rank IS NOT NULL;
