CREATE TABLE google_metrics (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,           -- ENS label only (no .eth), e.g. 'cinemas'
    metrics JSONB NOT NULL,               -- Full metrics response object
    expires_at TIMESTAMPTZ NOT NULL,      -- 30 days from generation
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_google_metrics_name UNIQUE (name)
);

CREATE INDEX idx_google_metrics_expires_at ON google_metrics(expires_at);
