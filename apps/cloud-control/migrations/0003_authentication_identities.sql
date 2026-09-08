-- Provider identities and password/verification material are separate from the
-- public users record. Never select these tables in an API response or log their
-- values. `password_hash` must be an Argon2id PHC string generated server-side.

BEGIN;

CREATE TYPE cloud_identity_provider AS ENUM ('google', 'github');

CREATE TABLE user_identities (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider cloud_identity_provider NOT NULL,
  provider_subject TEXT NOT NULL,
  email_at_link CITEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);

CREATE TABLE password_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  failed_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  CHECK (length(password_hash) >= 32)
);

-- The raw one-time value is sent only by email and compared after hashing. A
-- consumed token cannot be replayed, and expiry is checked by the transaction
-- that consumes it.
CREATE TABLE email_verification_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (octet_length(token_hash) >= 32)
);
CREATE INDEX email_verification_tokens_pending_user_idx
  ON email_verification_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE password_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE email_verification_tokens FORCE ROW LEVEL SECURITY;

-- Identity metadata may be read by its owner for account settings; credentials
-- and verification tokens intentionally have no browser/application read policy.
CREATE POLICY user_identities_self_read ON user_identities FOR SELECT
  USING (user_id = app_current_user_id());

-- Signup is an atomic server transaction: it sets its newly generated UUID as
-- `synara.user_id`, inserts the user, password credential, personal org, and
-- owner membership, then commits. No policy permits cross-user writes.
CREATE POLICY users_self_create ON users FOR INSERT
  WITH CHECK (id = app_current_user_id() AND disabled_at IS NULL);
CREATE POLICY password_credentials_self_create ON password_credentials FOR INSERT
  WITH CHECK (user_id = app_current_user_id());
CREATE POLICY identities_self_create ON user_identities FOR INSERT
  WITH CHECK (user_id = app_current_user_id());
CREATE POLICY verification_tokens_self_create ON email_verification_tokens FOR INSERT
  WITH CHECK (user_id = app_current_user_id());

COMMIT;
