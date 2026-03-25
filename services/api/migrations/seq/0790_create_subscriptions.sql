-- Stripe customer mapping
ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255) UNIQUE;
CREATE INDEX idx_users_stripe_customer_id ON users(stripe_customer_id);

-- Subscription tier: free, plus, pro, gold
ALTER TABLE users ADD COLUMN subscription_tier VARCHAR(20) DEFAULT 'free' NOT NULL;

-- Stripe subscription billing status: free, trialing, active, past_due, cancelled, expired
ALTER TABLE users ADD COLUMN subscription_status VARCHAR(50) DEFAULT 'free' NOT NULL;

ALTER TABLE users ADD COLUMN subscription_stripe_id VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN subscription_price_id VARCHAR(255);
ALTER TABLE users ADD COLUMN subscription_current_period_start TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN subscription_current_period_end TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN subscription_cancel_at_period_end BOOLEAN DEFAULT FALSE;

CREATE INDEX idx_users_subscription_tier ON users(subscription_tier);

-- Billing event log (audit trail of all Stripe webhook events we process)
CREATE TABLE billing_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_billing_events_user_id ON billing_events(user_id);
CREATE INDEX idx_billing_events_event_type ON billing_events(event_type);
