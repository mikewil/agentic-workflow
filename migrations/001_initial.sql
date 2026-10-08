-- Run as the migration owner. Runtime connections must use lifecycle_app (never the owner).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lifecycle_app') THEN
    CREATE ROLE lifecycle_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY);
CREATE TABLE users (id uuid PRIMARY KEY, github_id text UNIQUE NOT NULL, login text NOT NULL, avatar text);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE oauth_states (token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE tenants (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, branding jsonb NOT NULL DEFAULT '{}');
CREATE TABLE memberships (tenant_id uuid REFERENCES tenants(id), user_id uuid REFERENCES users(id), role text NOT NULL CHECK(role IN ('admin','operator','viewer')), PRIMARY KEY(tenant_id,user_id));
CREATE TABLE invitations (id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants(id), github_login text NOT NULL, role text NOT NULL CHECK(role IN ('admin','operator','viewer')), expires_at timestamptz NOT NULL, UNIQUE(tenant_id,github_login));
CREATE TABLE integrations (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), provider text NOT NULL CHECK(provider IN ('github','slack')), config jsonb NOT NULL DEFAULT '{}', encrypted_secret text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,provider));
CREATE TABLE runners (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, token_hash text UNIQUE NOT NULL, last_seen timestamptz, revoked boolean NOT NULL DEFAULT false, UNIQUE(tenant_id,id));
CREATE TABLE projects (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, repo text NOT NULL, config jsonb NOT NULL, policy jsonb NOT NULL, policy_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,repo));
CREATE TABLE work_items (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, external_id integer NOT NULL, title text NOT NULL, body text NOT NULL DEFAULT '', ready_at timestamptz, state text NOT NULL DEFAULT 'open', FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id), UNIQUE(tenant_id,id), UNIQUE(tenant_id,project_id,external_id));
CREATE TABLE runs (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, work_item_id uuid NOT NULL, status text NOT NULL DEFAULT 'queued', stage text NOT NULL DEFAULT 'discovery', policy_version integer NOT NULL, policy_snapshot jsonb NOT NULL, context jsonb NOT NULL DEFAULT '{}', active_ms bigint NOT NULL DEFAULT 0, repairs integer NOT NULL DEFAULT 0, cancellation_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id), FOREIGN KEY(tenant_id,work_item_id) REFERENCES work_items(tenant_id,id), UNIQUE(tenant_id,id));
CREATE UNIQUE INDEX one_open_run_per_item ON runs(tenant_id,work_item_id) WHERE status NOT IN ('succeeded','failed','cancelled','rolled_back');
CREATE UNIQUE INDEX one_active_run_per_project ON runs(tenant_id,project_id) WHERE status NOT IN ('queued','succeeded','failed','cancelled','rolled_back');
CREATE TABLE jobs (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, kind text NOT NULL, stage text NOT NULL, status text NOT NULL DEFAULT 'pending', lease_token uuid, runner_id uuid, leased_at timestamptz, lease_until timestamptz, payload jsonb NOT NULL DEFAULT '{}', result jsonb, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id), FOREIGN KEY(tenant_id,runner_id) REFERENCES runners(tenant_id,id), UNIQUE(tenant_id,id));
CREATE UNIQUE INDEX one_live_job_per_run ON jobs(tenant_id,run_id) WHERE status IN ('pending','leased');
CREATE TABLE events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, type text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id));
CREATE TABLE stage_results (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, stage text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id));
CREATE TABLE artifacts (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, name text NOT NULL, media_type text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id));
CREATE TABLE questions (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, question text NOT NULL, answer text, answered_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id));
CREATE TABLE project_profiles (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, profile jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id));
CREATE TABLE effects (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, key text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'prepared', request jsonb NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id), UNIQUE(tenant_id,run_id,key));
CREATE TABLE releases (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, sha text NOT NULL, previous_sha text, deployed_at timestamptz NOT NULL DEFAULT now(), verify_until timestamptz NOT NULL, next_check timestamptz NOT NULL DEFAULT now(), failures integer NOT NULL DEFAULT 0, healthy_samples integer NOT NULL DEFAULT 0, rollback_started boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'verifying', FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id));
CREATE TABLE incidents (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, release_id uuid NOT NULL REFERENCES releases(id), status text NOT NULL DEFAULT 'open', detail text NOT NULL, external_issue integer, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id), UNIQUE(tenant_id,release_id));
CREATE TABLE inbox (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), provider text NOT NULL, delivery_id text NOT NULL, payload jsonb NOT NULL, processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,provider,delivery_id));
CREATE TABLE slack_links (tenant_id uuid NOT NULL REFERENCES tenants(id), workspace_id text NOT NULL, slack_user_id text NOT NULL, user_id uuid NOT NULL REFERENCES users(id), PRIMARY KEY(tenant_id,workspace_id,slack_user_id));
CREATE TABLE link_nonces (token_hash text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), workspace_id text NOT NULL, slack_user_id text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE notifications (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, text text NOT NULL, sent_at timestamptz, FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id));
-- Global authentication data is only consumed by trusted server code, never sent to the client.
GRANT SELECT,INSERT,UPDATE,DELETE ON users,sessions,oauth_states TO lifecycle_app;
GRANT USAGE ON SCHEMA public TO lifecycle_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO lifecycle_app;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['tenants','memberships','invitations','integrations','runners','projects','work_items','runs','jobs','events','stage_results','artifacts','questions','project_profiles','effects','releases','incidents','inbox','slack_links','link_nonces','notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_boundary ON %I USING (%I = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (%I = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab,CASE WHEN tab='tenants' THEN 'id' ELSE 'tenant_id' END,CASE WHEN tab='tenants' THEN 'id' ELSE 'tenant_id' END);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO lifecycle_app',tab);
  END LOOP;
END $$;
-- These narrow directory functions never return tenant secrets, content, or credentials.
CREATE FUNCTION tenant_directory() RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT id FROM tenants $$;
CREATE FUNCTION user_tenants(uid uuid) RETURNS TABLE(id uuid,slug text,name text,branding jsonb,role text) LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT t.id,t.slug,t.name,t.branding,m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=uid $$;
CREATE FUNCTION runner_identity(hash text) RETURNS TABLE(id uuid,tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT id,tenant_id FROM runners WHERE token_hash=hash AND NOT revoked $$;
CREATE FUNCTION accept_invitations(uid uuid,login text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ INSERT INTO memberships SELECT tenant_id,uid,role FROM invitations WHERE lower(github_login)=lower(login) AND expires_at>now() ON CONFLICT DO NOTHING; DELETE FROM invitations WHERE lower(github_login)=lower(login) AND expires_at>now(); $$;
REVOKE ALL ON FUNCTION tenant_directory(),user_tenants(uuid),runner_identity(text),accept_invitations(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_directory(),user_tenants(uuid),runner_identity(text),accept_invitations(uuid,text) TO lifecycle_app;
