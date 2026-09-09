-- CORTEX Cloud API tokens. The public brand is CORTEX; existing `synara.*`
-- transaction settings intentionally remain stable until a separately reviewed migration.
-- Raw tokens never enter this table. Store a domain-separated SHA-256 digest and a short
-- non-secret prefix only; compare candidate digests in the application with timingSafeEqual.

BEGIN;

CREATE TABLE api_tokens (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash BYTEA NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(token_prefix)) >= 12),
  CHECK (octet_length(token_hash) = 32),
  CHECK (cardinality(scopes) > 0),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at)
);

CREATE INDEX api_tokens_organization_active_idx
  ON api_tokens (organization_id, created_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX api_tokens_user_active_idx
  ON api_tokens (user_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;

-- RLS permits a user to manage only their own tokens inside the selected organization. A future
-- organization-admin workflow must use a narrowly scoped server command, not broaden this policy.
CREATE POLICY api_tokens_owner_read ON api_tokens FOR SELECT
  USING (
    organization_id = app_current_organization_id()
    AND user_id = app_current_user_id()
    AND app_is_active_member_of_current_organization()
  );
CREATE POLICY api_tokens_owner_write ON api_tokens FOR ALL
  USING (
    organization_id = app_current_organization_id()
    AND user_id = app_current_user_id()
    AND app_is_active_member_of_current_organization()
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND user_id = app_current_user_id()
    AND app_is_active_member_of_current_organization()
  );

COMMIT;
