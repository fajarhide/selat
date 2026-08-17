<img src="assets/logo.svg" alt="" width="72" align="right">

# Selat

**One credential for every tool your agent calls.**

You are building an agent. It needs GitHub, then Gmail, then Discord. Each one wants
its own OAuth dance, its own token refresh, its own schema, its own error shape.
So you write a vault, a refresher, and a retry loop, and you write them again for
the next agent.

Selat is the gateway that holds all of it. Your workspace connects each upstream
once. Your agent holds one bearer token and calls `github__list_issues`. When you
connect or disconnect an upstream, that token does not change.

Selat is Indonesian for strait, the narrow passage every ship has to pass
through. The mark is that: two coasts, and one thing in the water between them.

Run it yourself from here, or use the hosted one at
[selat.weekndlabs.com](https://selat.weekndlabs.com), whose docs are at
[/docs](https://selat.weekndlabs.com/docs). The gateway and every adapter are
Apache-2.0 either way.

## 60 seconds to a real tool call

```sh
git clone https://github.com/fajarhide/selat && cd selat
cp .env.example .env
perl -pi -e "s/^VAULT_KEY=.*/VAULT_KEY=$(openssl rand -hex 32)/" .env
docker compose up -d
npm run quickstart
```

```
Workspace 3c0862e2-d0eb-4ca3-87e9-fcb80b683b44 created.
Registered providers: fake

Your gateway credential, shown once:

  slt_live_gdOhIUCc1cBeZP5…
```

That credential is shown once and stored as a hash, so keep it now:

```sh
export SELAT_TOKEN=slt_live_gdOhIUCc1cBeZP5…
```

Ask what it can do:

```sh
$ curl -s localhost:8080/v1/tools -H "Authorization: Bearer $SELAT_TOKEN"
```
```json
{
  "tools": [
    {
      "name": "fake__echo",
      "description": "Return the message argument unchanged, for connectivity checks",
      "inputSchema": {
        "type": "object",
        "properties": { "message": { "type": "string" } },
        "required": ["message"]
      },
      "write": false,
      "provider": "fake",
      "maturity": "experimental"
    }
  ],
  "catalog_truncated": false,
  "request_id": "c45c3d9b-9176-4b64-8f3f-e8363b3b837e"
}
```

Call one:

```sh
$ curl -s -X POST localhost:8080/v1/tools/fake__echo/call \
    -H "Authorization: Bearer $SELAT_TOKEN" -H 'content-type: application/json' \
    -d '{"message":"hello"}'
```
```json
{ "content": { "message": "hello" }, "nextCursor": null, "hasMore": false,
  "request_id": "ebe4d67a-f272-4646-8c03-50e551b6c880" }
```

No vendor account, no OAuth application, no waiting on an app review. The `fake`
provider ships enabled so you can see the whole shape of the thing before you
decide to care.

Point an MCP client at the same workspace and the same tools appear:

```json
{
  "mcpServers": {
    "selat": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer slt_live_…" }
    }
  }
}
```

MCP and REST are equals here. Claude Desktop and your LangGraph runtime see the
same catalog, backed by the same vault, metered on the same counter.

## Errors your agent can branch on

Most gateways hand your model a 500 and a stack trace. Selat answers with a
closed set of codes, so your agent can decide what to do instead of guessing.

```sh
$ curl -i -X POST localhost:8080/v1/tools/github__list_issues/call \
    -H "Authorization: Bearer $SELAT_TOKEN" -H 'content-type: application/json' \
    -d '{"owner":"vercel","repo":"next.js"}'
```
```
HTTP/1.1 403 Forbidden
X-Request-Id: ffef9d9c-4777-4320-a4bc-f43f0476916c
```
```json
{ "error": { "code": "provider_not_connected", "message": "github is not connected",
             "provider": "github", "request_id": "ffef9d9c-4777-4320-a4bc-f43f0476916c" } }
```

The full set: `invalid_arguments`, `invalid_credential`, `provider_not_connected`,
`credential_scope_denied`, `plan_blocked`, `tool_not_found`, `reauth_required`,
`quota_exceeded`, `rate_limited`, `upstream_error`, `upstream_timeout`. Nothing
else is ever returned.

A `reauth_required` carries a `reauth_url`, so your agent can tell a human
exactly what to click. A `rate_limited` carries `retry_after` in seconds. Every
response, success or failure, carries a `request_id` that also appears in the
log line for that call.

List-shaped tools always answer with `hasMore` and `nextCursor`:

```json
{ "content": { "items": [{ "id": "item-1" }] }, "nextCursor": "2", "hasMore": true }
```

A truncated list with no signal is treated as a defect here, not a tradeoff. An
agent that silently reasons over half a page is worse than one that errors.

## What is actually shipped

| Provider | Maturity | Tools |
|---|---|---|
| `github` | beta | Repository search, issues list, get and create, authenticated user |
| `gmail` | beta | Profile, message list and get, label |
| `gcal` | beta | Calendars, event list and get |
| `gdrive` | beta | About, file list and get |
| `discord` | beta | Bot user, guilds, channels, message list and post |
| `facebook` | beta | Authenticated user |
| `x` | experimental | User, post list and get, recent search, create post |
| `threads` | experimental | Profile, post list and get, replies |
| `notion` | experimental | Search, page, users |
| `slack` | experimental | Channels, users, post message |
| `fake` | experimental | Echoes its argument. Needs no vendor, for smoke tests |

Maturity rides on every tool in the catalog, so an agent can refuse to call
anything below `ga` if you want it to. Nothing is `ga` yet, and saying so is
cheaper than finding out later.

A provider whose client id is blank is left out of the registry entirely, so a
deployment serves what it has credentials for and nothing else. `gmail`, `gcal`
and `gdrive` share one Google grant, so one consent screen covers all three.

If you want a provider that is not here, the adapter contract is small and the
conformance suite tells you when you are done. See
[Writing a provider](#writing-a-provider).

## Connecting GitHub

Every provider needs an OAuth application. Self-hosting means bringing your own,
because the hosted applications are a cloud convenience and are deliberately not
in this repository.

```sh
# .env
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Set the callback in the vendor console to
`{PUBLIC_URL}/v1/connections/github/callback`, then:

```sh
curl -s -X POST localhost:8080/v1/connections/github/authorize \
  -H "Authorization: Bearer $SELAT_TOKEN"
# open the authorize_url, approve, done
```

Its tools appear as `github__list_issues` and friends. PKCE with S256 is
mandatory, including for vendors that do not require it. The `state` is stored
server side, single use, and expires in ten minutes.

Your agent's credential is untouched by any of this. That separation is the
whole design: humans manage connections, agents hold one bearer, and the two
never have to be redeployed together.

## Why not just call the APIs directly

You can, and for one agent against one service you probably should. Selat starts
paying for itself at the third upstream, or the second agent, or the first time
a refresh token rotates at 3am.

**Why not a per-vendor MCP server?** You end up running one process per service,
each with its own auth story, and your agent sees an unbounded tool list. Selat
gives you one endpoint, one token, and a catalog you can filter.

**Why not the model vendor's built-in connectors?** They work well inside that
vendor. Selat runs the same tools against any runtime, including the one you
wrote yourself, and you can host it on your own hardware with your own OAuth
applications.

**What about the tool list getting huge?** Agents degrade well before any API
limit, so the exposed catalog is capped at 60 tools per workspace and every tool
can be toggled individually. When the cap bites, `catalog_truncated` says so
instead of quietly shortening the list.

## Security

Upstream tokens are sealed with AES-256-GCM under a key from `VAULT_KEY`, with
the workspace and grant bound into the additional authenticated data, so a
ciphertext copied into another tenant's row will not decrypt.

Gateway credentials are stored as SHA-256 hashes and shown once. The `slt_live_`
prefix is fixed so the pattern can be registered with GitHub secret scanning,
which turns a leaked token into an automatic revocation instead of an incident.

No token, upstream or gateway, is ever written to a log or returned in a
response body. Every query against a tenant table carries a workspace predicate,
and a test walks the source to fail the build if one does not. The single
exception, deleting an expired OAuth state by its random primary key, has to
name itself in the source with the reason, so it lands in review rather than in
a quietly loosened rule.

Report a vulnerability privately through GitHub security advisories rather than
a public issue.

## API

| Surface | What it does |
|---|---|
| `POST /mcp` | MCP Streamable HTTP: `tools/list`, `tools/call` |
| `GET /v1/tools` | Namespaced catalog with input schemas. Filter with `?provider=` |
| `POST /v1/tools/{name}/call` | Invoke a tool. Accepts `Idempotency-Key` on writes |
| `GET /v1/connections` | What is available and what is connected |
| `POST /v1/connections/{provider}/authorize` | Start an OAuth connect |
| `DELETE /v1/connections/{provider}` | Disconnect and drop the tokens |
| `GET /v1/whoami` | Workspace, plan, connected providers. No secrets |
| `GET /v1/health`, `GET /v1/ready` | Liveness and readiness |

## Deploying it yourself

One long lived process, Postgres on the same host, and a reverse proxy in front
doing TLS. Nothing in the gateway is stateful between requests, but it does hold
a connection pool and refresh tokens in flight, so it wants to be a server rather
than a function. On a serverless platform every instance opens its own pool
against a ceiling they all share, and the database has to be reachable from the
public internet for any of it to work.

```sh
sudo apt-get install -y postgresql
sudo -u postgres createuser --pwprompt selat
sudo -u postgres createdb -O selat selat

git clone https://github.com/fajarhide/selat.git /opt/selat
sudo podman build -t selat:latest /opt/selat
```

Keep the environment in a root owned file rather than in the unit, so
`systemctl show` never prints `VAULT_KEY`:

```sh
sudo install -d -m 750 /etc/selat
sudo tee /etc/selat/selat.env >/dev/null <<'EOF'
PORT=8081
DATABASE_URL=postgres://selat:...@127.0.0.1:5432/selat
VAULT_KEY=...
PUBLIC_URL=https://api.example.com
EOF
sudo chmod 600 /etc/selat/selat.env
```

Run it under systemd with a podman quadlet at
`/etc/containers/systemd/selat.container`:

```ini
[Unit]
After=postgresql.service
Requires=postgresql.service

[Container]
Image=localhost/selat:latest
Network=host
EnvironmentFile=/etc/selat/selat.env

[Service]
Restart=always

[Install]
WantedBy=multi-user.target
```

`Network=host` is deliberate. The alternative is a bridge network, which forces
Postgres to listen on an interface the container network can reach. This way it
stays on localhost and only the proxy is exposed.

Run `systemctl daemon-reload && systemctl start selat`, then point the proxy at
`127.0.0.1:8081` and check `/v1/ready`. With Caddy that is three lines:

```
api.example.com {
	reverse_proxy 127.0.0.1:8081
}
```

Migrations run at start, so a fresh database needs no separate step. Redeploying
is a pull, a build and a restart.

Podman writes an OCI spec that older crun rejects, and the build then dies at
`RUN npm ci` with `unknown version specified`, which reads like an npm problem
and is not. If podman came from a newer release than the rest of the system,
upgrade crun from the same place.

## Writing a provider

Implement `ProviderAdapter` in `src/adapters/providers/`, then run the
conformance suite against it. The suite checks the things that actually break
agents: honest pagination, unique tool names, object input schemas, errors
mapped to the closed code set, and never leaking the access token into a result.

```ts
describe('my provider conformance', () => {
  runAdapterConformance(myProvider(), {
    pagedTool: 'list_things',
    fullPage: { args: { owner: 'o' }, upstream: fakeUpstream([{ match: /things/, body: itemsPage(30) }]) },
    lastPage: { args: { owner: 'o' }, upstream: fakeUpstream([{ match: /things/, body: itemsPage(2) }]) },
  })
})
```

A contribution merges when that suite is green. No adapter has ever needed a
network connection to be tested, and yours should not either.

## Development

```sh
docker compose up -d db          # or a local Postgres on 5432
createdb selat_test
npm install
npm test
npm run dev
```

Tests run against a real Postgres. `TEST_DATABASE_URL` defaults to the database
docker compose creates.

## License

Apache-2.0. The gateway and every provider adapter are open, and always will be.
Billing, organisations, SSO and the hosted OAuth applications live in a separate
private repository, which reaches this one over HTTP like any other client.
