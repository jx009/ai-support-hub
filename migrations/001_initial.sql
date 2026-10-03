BEGIN;
CREATE TABLE IF NOT EXISTS support_schema_versions(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS projects(
 id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1, api_key text NOT NULL UNIQUE, api_secret text NOT NULL,
 hook_secret text NOT NULL, settings jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nonces(project_id uuid NOT NULL REFERENCES projects(id), nonce text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(project_id,nonce));
CREATE UNIQUE INDEX IF NOT EXISTS project_account_isolation ON projects ((settings->>'chatwootUrl'),(settings->>'accountId'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cw_hook_secret text;
CREATE TABLE IF NOT EXISTS contacts(id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), external_id text NOT NULL, remote_id bigint NOT NULL, source_id text NOT NULL, UNIQUE(project_id,external_id));
CREATE TABLE IF NOT EXISTS conversations(
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), external_id text NOT NULL,
 request_key text NOT NULL, remote_id bigint, ticket boolean NOT NULL DEFAULT false,
 category text, subject text, handoff_version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,external_id,request_key), UNIQUE(project_id,remote_id)
);
CREATE TABLE IF NOT EXISTS operations(
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), conversation_id uuid REFERENCES conversations(id),
 external_id text NOT NULL, kind text NOT NULL, request_key text NOT NULL, payload_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending', result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,external_id,kind,request_key)
);
CREATE TABLE IF NOT EXISTS ai_jobs(
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), conversation_id uuid NOT NULL REFERENCES conversations(id),
 message_id bigint NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 result jsonb, error text, next_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,message_id)
);
CREATE INDEX IF NOT EXISTS conversation_owner ON conversations(project_id,external_id,created_at DESC);
CREATE INDEX IF NOT EXISTS job_pending ON ai_jobs(state,next_at,message_id);
INSERT INTO support_schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
COMMIT;
