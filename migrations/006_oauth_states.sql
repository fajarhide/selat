CREATE TABLE oauth_states (
  state        text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prefix       text NOT NULL,
  verifier     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
