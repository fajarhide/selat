CREATE TABLE usage_events (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES gateway_credentials(id) ON DELETE SET NULL,
  provider      text NOT NULL,
  tool          text NOT NULL,
  outcome       text NOT NULL,
  latency_ms    integer NOT NULL,
  request_id    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_workspace_time ON usage_events (workspace_id, created_at DESC);

CREATE TABLE usage_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period       date NOT NULL,
  calls        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period)
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor        text NOT NULL,
  action       text NOT NULL,
  target       text,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_workspace_time ON audit_log (workspace_id, created_at DESC);
