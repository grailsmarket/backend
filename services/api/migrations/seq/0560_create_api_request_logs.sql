CREATE TABLE api_request_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    address VARCHAR(42) NOT NULL,
    method VARCHAR(10) NOT NULL,
    route VARCHAR(255) NOT NULL,
    path VARCHAR(500) NOT NULL,
    query_params JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_request_logs_user_id ON api_request_logs(user_id, created_at DESC);
CREATE INDEX idx_api_request_logs_created_at ON api_request_logs(created_at DESC);
CREATE INDEX idx_api_request_logs_route ON api_request_logs(route, created_at DESC);
