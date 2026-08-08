CREATE TABLE gateway_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  last4         text NOT NULL,
  name          text NOT NULL DEFAULT 'default',
  scope         jsonb NOT NULL DEFAULT '{"providers":null,"readOnly":false}'::jsonb,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gateway_credentials_workspace ON gateway_credentials (workspace_id);
