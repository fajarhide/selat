CREATE TABLE grants (
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  grant_id       text NOT NULL,
  access_token   jsonb NOT NULL,
  refresh_token  jsonb,
  expires_at     timestamptz,
  scopes         text[] NOT NULL DEFAULT '{}',
  key_version    integer NOT NULL DEFAULT 1,
  reauth_needed  boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, grant_id)
);
