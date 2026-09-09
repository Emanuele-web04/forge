-- Synara cloud control plane: PostgreSQL only. Do not apply this migration to
-- the desktop/local SQLite database. Every request transaction must execute:
--   SET LOCAL synara.user_id = '<authenticated UUID>';
--   SET LOCAL synara.organization_id = '<authorized UUID>';
-- before accessing organization-owned tables.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE cloud_organization_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE cloud_workspace_status AS ENUM ('provisioning', 'ready', 'suspended', 'destroyed');
CREATE TYPE cloud_task_status AS ENUM ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled');
CREATE TYPE cloud_repository_permission AS ENUM ('read', 'write', 'admin');
CREATE TYPE cloud_workspace_termination_reason AS ENUM (
  'user-request', 'expired', 'quota-exceeded', 'security-incident'
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  email_verified_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(trim(email::text)) > 2)
);

CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  slug CITEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  personal_owner_user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(slug::text)) > 0)
);

CREATE TABLE memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role cloud_organization_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_active_user_idx ON memberships (user_id, organization_id) WHERE revoked_at IS NULL;

-- Raw session values never enter this table: store only an HMAC/SHA-256 digest.
CREATE TABLE web_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_hash BYTEA,
  user_agent TEXT,
  CHECK (expires_at > created_at),
  CHECK (octet_length(token_hash) >= 32)
);
CREATE INDEX web_sessions_active_user_idx ON web_sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE github_connections (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  github_account_id TEXT NOT NULL,
  credential_ciphertext BYTEA NOT NULL,
  credential_key_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, github_account_id),
  UNIQUE (id, organization_id),
  CHECK (octet_length(credential_ciphertext) > 0)
);

CREATE TABLE connected_repositories (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  github_connection_id UUID NOT NULL,
  github_installation_id TEXT NOT NULL,
  github_repo_node_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  permission_level cloud_repository_permission NOT NULL,
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (organization_id, github_repo_node_id),
  UNIQUE (id, organization_id),
  CHECK (length(trim(owner)) > 0),
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(default_branch)) > 0)
);
CREATE INDEX connected_repositories_active_org_idx ON connected_repositories (organization_id, name) WHERE revoked_at IS NULL;

CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connected_repository_id UUID NOT NULL,
  name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  work_branch TEXT NOT NULL,
  region TEXT NOT NULL,
  status cloud_workspace_status NOT NULL DEFAULT 'provisioning',
  runner_id TEXT,
  runner_generation INTEGER NOT NULL DEFAULT 0 CHECK (runner_generation >= 0),
  quota_policy_id TEXT NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspend_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  destroyed_at TIMESTAMPTZ,
  termination_reason cloud_workspace_termination_reason,
  CHECK (length(trim(name)) > 0),
  CHECK (expires_at > created_at),
  CHECK ((status = 'destroyed') = (destroyed_at IS NOT NULL)),
  CHECK ((status = 'destroyed') = (termination_reason IS NOT NULL)),
  UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX workspaces_live_work_branch_idx ON workspaces (organization_id, work_branch) WHERE status <> 'destroyed';
CREATE INDEX workspaces_reconcile_idx ON workspaces (status, expires_at) WHERE status <> 'destroyed';
CREATE INDEX workspaces_organization_idx ON workspaces (organization_id, last_active_at DESC);

CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  title TEXT NOT NULL,
  status cloud_task_status NOT NULL DEFAULT 'queued',
  provider TEXT NOT NULL,
  provider_session_ref TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  CHECK (length(trim(title)) > 0),
  CHECK ((finished_at IS NULL) OR (started_at IS NOT NULL AND finished_at >= started_at)),
  UNIQUE (id, organization_id)
);
CREATE INDEX tasks_workspace_created_idx ON tasks (workspace_id, created_at DESC);

CREATE TABLE task_events (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  task_id UUID NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, sequence),
  CHECK (length(trim(type)) > 0)
);
CREATE INDEX task_events_workspace_idx ON task_events (workspace_id, occurred_at DESC);

CREATE TABLE workspace_checkpoints (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  reason TEXT NOT NULL,
  git_head_sha TEXT NOT NULL,
  git_status_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE TABLE quota_usage (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  metric TEXT NOT NULL,
  quantity BIGINT NOT NULL CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, period_start, metric)
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_id UUID,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(trim(action)) > 0),
  CHECK (length(trim(resource_type)) > 0)
);
CREATE INDEX audit_log_organization_created_idx ON audit_log (organization_id, created_at DESC);

-- Composite tenant foreign keys make cross-organization references impossible,
-- even for a buggy control-plane query running with elevated database access.
ALTER TABLE connected_repositories
  ADD CONSTRAINT connected_repositories_connection_organization_fk
  FOREIGN KEY (github_connection_id, organization_id)
  REFERENCES github_connections (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_repository_organization_fk
  FOREIGN KEY (connected_repository_id, organization_id)
  REFERENCES connected_repositories (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_workspace_organization_fk
  FOREIGN KEY (workspace_id, organization_id)
  REFERENCES workspaces (id, organization_id) ON DELETE CASCADE;
ALTER TABLE task_events
  ADD CONSTRAINT task_events_task_organization_fk
  FOREIGN KEY (task_id, organization_id)
  REFERENCES tasks (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT task_events_workspace_organization_fk
  FOREIGN KEY (workspace_id, organization_id)
  REFERENCES workspaces (id, organization_id) ON DELETE CASCADE;
ALTER TABLE workspace_checkpoints
  ADD CONSTRAINT workspace_checkpoints_workspace_organization_fk
  FOREIGN KEY (workspace_id, organization_id)
  REFERENCES workspaces (id, organization_id) ON DELETE CASCADE;

-- RLS is deliberately fail-closed when request settings are absent. A database
-- owner/admin migration connection is not an application request identity.
CREATE FUNCTION app_current_user_id() RETURNS UUID
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('synara.user_id', true), '')::uuid $$;
CREATE FUNCTION app_current_organization_id() RETURNS UUID
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('synara.organization_id', true), '')::uuid $$;
CREATE FUNCTION app_is_active_member(target_organization_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.memberships
      WHERE organization_id = target_organization_id
        AND user_id = public.app_current_user_id()
        AND revoked_at IS NULL
    )
  $$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self ON users FOR SELECT USING (id = app_current_user_id());
CREATE POLICY organizations_member_read ON organizations FOR SELECT USING (app_is_active_member(id));
CREATE POLICY memberships_member_read ON memberships FOR SELECT USING (app_is_active_member(organization_id));
CREATE POLICY sessions_self ON web_sessions FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY github_connections_member_read ON github_connections FOR SELECT USING (app_is_active_member(organization_id));
CREATE POLICY repositories_member_read ON connected_repositories FOR SELECT USING (app_is_active_member(organization_id));
CREATE POLICY workspaces_member_read ON workspaces FOR SELECT USING (app_is_active_member(organization_id));
CREATE POLICY tasks_member_read ON tasks FOR SELECT USING (app_is_active_member(organization_id));
CREATE POLICY task_events_member_read ON task_events FOR SELECT USING (app_is_active_member(organization_id));
CREATE POLICY checkpoints_member_read ON workspace_checkpoints FOR SELECT USING (app_is_active_member(organization_id));
CREATE POLICY quota_member_read ON quota_usage FOR SELECT USING (app_is_active_member(organization_id));
CREATE POLICY audit_member_read ON audit_log FOR SELECT USING (app_is_active_member(organization_id));

COMMIT;
