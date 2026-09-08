-- Make the tenant boundary apply to the control-plane application role as well
-- as ordinary database roles. The only account that bypasses these policies is
-- the separately managed migration/maintenance role; it must never serve HTTP.

BEGIN;

CREATE FUNCTION app_is_active_member_of_current_organization() RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT public.app_current_organization_id() IS NOT NULL
      AND public.app_is_active_member(public.app_current_organization_id())
  $$;

ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE web_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE github_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE connected_repositories FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE task_events FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE quota_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- A user can create only their own personal organization. The service creates
-- its matching owner membership in the same transaction through the narrowly
-- scoped bootstrap policy below.
CREATE POLICY organizations_create_personal ON organizations FOR INSERT
  WITH CHECK (personal_owner_user_id = app_current_user_id() AND deleted_at IS NULL);
CREATE POLICY memberships_create_personal_owner ON memberships FOR INSERT
  WITH CHECK (
    user_id = app_current_user_id()
    AND role = 'owner'
    AND EXISTS (
      SELECT 1 FROM organizations
      WHERE organizations.id = memberships.organization_id
        AND organizations.personal_owner_user_id = app_current_user_id()
        AND organizations.deleted_at IS NULL
    )
  );

-- Session rotation only ever writes a row associated with the authenticated
-- user. The HTTP service remains responsible for hashing and expiry policy.
CREATE POLICY sessions_self_insert ON web_sessions FOR INSERT
  WITH CHECK (user_id = app_current_user_id());
CREATE POLICY sessions_self_update ON web_sessions FOR UPDATE
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- Tenant-scoped writes require both an explicit transaction organization and an
-- active membership. RBAC (owner/admin/member/viewer) is enforced by the
-- control-plane command layer before issuing these statements; RLS remains the
-- final, independent tenant-isolation fence.
CREATE POLICY github_connections_member_write ON github_connections FOR ALL
  USING (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  );
CREATE POLICY repositories_member_write ON connected_repositories FOR ALL
  USING (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  );
CREATE POLICY workspaces_member_write ON workspaces FOR ALL
  USING (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  );
CREATE POLICY tasks_member_write ON tasks FOR ALL
  USING (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  );
CREATE POLICY task_events_member_insert ON task_events FOR INSERT
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  );
CREATE POLICY checkpoints_member_write ON workspace_checkpoints FOR ALL
  USING (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  );
CREATE POLICY quota_member_write ON quota_usage FOR ALL
  USING (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  );
CREATE POLICY audit_member_insert ON audit_log FOR INSERT
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND app_is_active_member_of_current_organization()
  );

COMMIT;
