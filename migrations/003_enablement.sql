CREATE TABLE provider_enablements (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prefix       text NOT NULL,
  enabled_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, prefix)
);

CREATE TABLE tool_overrides (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_name    text NOT NULL,
  enabled      boolean NOT NULL,
  PRIMARY KEY (workspace_id, tool_name)
);
