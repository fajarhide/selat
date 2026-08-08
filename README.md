# Selat

The unified tool gateway for AI agents. A workspace connects each upstream once,
agents use one credential, and the same tools are reachable over MCP Streamable
HTTP and a plain REST API.

Connecting or disconnecting an upstream never changes the credential your agent
holds.

## Quickstart

```sh
git clone https://github.com/fajarhide/selat && cd selat
cp .env.example .env && sed -i '' "s/^VAULT_KEY=.*/VAULT_KEY=$(openssl rand -hex 32)/" .env
docker compose up -d
npm run quickstart
```

The last command prints a credential once. Use it:

```sh
curl -s localhost:8080/v1/tools -H "Authorization: Bearer slt_live_..."

curl -s -X POST localhost:8080/v1/tools/fake__echo/call \
  -H "Authorization: Bearer slt_live_..." -H 'content-type: application/json' \
  -d '{"message":"hello"}'
```

Or point an MCP client at it:

```json
{
  "mcpServers": {
    "selat": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer slt_live_..." }
    }
  }
}
```

The `fake` provider is enabled out of the box and needs no vendor account, so a
first successful tool call does not wait on an OAuth application.

## Connecting a real upstream

Every provider needs an OAuth application. Self-hosting means bringing your own:
the hosted applications are a cloud convenience and are deliberately not in this
repository.

```sh
# .env
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Set the callback in the vendor console to
`{PUBLIC_URL}/v1/connections/{provider}/callback`, then:

```sh
curl -s -X POST localhost:8080/v1/connections/github/authorize \
  -H "Authorization: Bearer slt_live_..."
# open the authorize_url, approve, done
```

Its tools appear as `github__list_issues` and friends. The credential does not
change.

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

Every response carries `request_id`, also sent as the `X-Request-Id` header and
present in every log line for that call.

Errors use a closed set of codes, so an agent can branch on them:
`invalid_arguments`, `invalid_credential`, `provider_not_connected`,
`credential_scope_denied`, `plan_blocked`, `tool_not_found`, `reauth_required`,
`quota_exceeded`, `rate_limited`, `upstream_error`, `upstream_timeout`.

`plan_blocked` is reserved for a hosted deployment gating a provider by plan. A
self-host never raises it, but it is part of the published contract so an agent
written against the cloud behaves identically here.

A `reauth_required` carries `reauth_url`, so an agent can tell a human exactly
what to click.

List-shaped tools always answer with `hasMore` and `nextCursor`. Silent
truncation is treated as a defect, not a tradeoff.

## Providers

| Provider | Grant | Maturity |
|---|---|---|
| `fake` | none | experimental, for smoke tests and local development |
| `github` | github | beta |

Maturity is reported on every tool. Only `ga` providers are covered by an SLA.

## Writing a provider

Implement `ProviderAdapter` in `src/adapters/providers/`, then run the
conformance suite against it. The suite checks the things that break agents:
honest pagination, unique tool names, object input schemas, errors mapped to the
closed code set, and never returning the access token in a result.

```ts
describe('my provider conformance', () => {
  runAdapterConformance(myProvider(), {
    pagedTool: 'list_things',
    fullPage: { args: { owner: 'o' }, upstream: fakeUpstream([{ match: /things/, body: itemsPage(30) }]) },
    lastPage: { args: { owner: 'o' }, upstream: fakeUpstream([{ match: /things/, body: itemsPage(2) }]) },
  })
})
```

A contribution merges when that suite is green.

## Development

```sh
docker compose up -d db          # or a local Postgres on 5432
createdb selat_test
npm install
npm test
npm run dev
```

Tests run against a real Postgres. `TEST_DATABASE_URL` defaults to the database
that docker compose creates.

## Security

Upstream tokens are sealed with AES-256-GCM under a key from `VAULT_KEY`, with
the workspace and grant bound into the additional authenticated data, so a row
copied between tenants does not decrypt. Credentials are stored as SHA-256
hashes and shown once. No token, upstream or gateway, is ever logged or returned
in a response body.

Report a vulnerability privately through GitHub security advisories rather than
a public issue.

## License

Apache-2.0.
