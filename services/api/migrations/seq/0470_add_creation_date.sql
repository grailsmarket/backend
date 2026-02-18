ALTER TABLE ens_names ADD COLUMN creation_date TIMESTAMPTZ;
CREATE INDEX idx_ens_names_creation_date ON ens_names(creation_date);
