-- A handoff between tool calls, not a store. A download too large to put in a
-- context window lands here and is fetched by id, and the row is unreachable
-- after the TTL the application enforces.
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mime_type    text NOT NULL,
  size         integer NOT NULL,
  bytes        bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX files_workspace_created ON files (workspace_id, created_at DESC);
