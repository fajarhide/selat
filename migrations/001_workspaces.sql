CREATE TABLE workspaces (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  plan         text NOT NULL DEFAULT 'free',
  call_quota   integer NOT NULL DEFAULT 5000,
  created_at   timestamptz NOT NULL DEFAULT now()
);
