# Contributing

Two rules here are not guessable from the code, and everything else follows the
usual shape. Read these two and you can ignore the rest of this file.

## A test has to be proven able to fail

A check that cannot fail proves nothing. So after writing one, break the thing
it guards, watch it go red, and put it back. Paste the red output in the pull
request. This is the only ritual this repository actually insists on, and it is
the reason a bug found in August was caught by a test written in July.

Commit before breaking anything on purpose, so an undo cannot lose work.

## A provider is data, not code

There is one HTTP executor. A provider is a `ProviderManifest`: a base URL, an
auth scheme, and a list of tools naming their method, path, arguments and the
fields worth keeping. `src/adapters/providers/github.ts` is a short one to read
first.

If a manifest cannot express what an upstream needs, that is a gap in the
executor and it is worth saying so in an issue. Several already were: an
argument that had to travel in the query string of a `PATCH`, an argument that
had to be a list, a response that was bytes rather than JSON. Each became one
field on the manifest that every provider then had.

Do not add a handler for one endpoint.

## Before writing code

Open an issue. A one-line fix is a one-line issue. What makes an issue useful
here is a command someone else can run and the `file:line` that decides the
behaviour, with what you observed kept separate from what you diagnosed.

An agent can see only so many tools at once, so a new tool costs a slot. Name
the three to five worth having rather than wrapping an entire API.

## Running it

```sh
npm install
npm test          # against a real Postgres, TEST_DATABASE_URL
npm run typecheck
npx selat         # the embedded database, no setup
```

Tests use a real Postgres because the gateway does, and `docker compose up -d db`
is the quickest way to have one. The embedded database is for trying the
gateway, not for running its test suite.

## Commits and pull requests

Conventional commits, scoped to the module. The subject says the outcome rather
than the edit: `stop dropping the answer` beats `fix bug`. The body says why,
and what the alternative was if you rejected one.

Put `Closes #N` in the pull request body before it merges. The keyword is read
at merge time, so adding it afterwards does nothing.

## Reporting something sensitive

A vulnerability, a leaked credential, or anything that should not be public
while it is being fixed goes through
[a security advisory](https://github.com/fajarhide/selat/security/advisories/new),
not an issue.
