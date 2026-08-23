# Security

## Reporting

Open a [security advisory](https://github.com/fajarhide/selat/security/advisories/new).
Not an issue, not a pull request, and not a public discussion, because those are
readable before anything is fixed.

There is one maintainer, so there is no response time to promise. What is
promised instead: an advisory is read before other work, and a report is never
left without an answer, including an answer that says the behaviour is intended
and why.

If a report includes command output, check it for credentials first. Several
things this gateway prints are real tokens.

## What is worth attacking

Selat exists to hold other people's credentials, so the interesting targets are
narrow and worth naming.

- **Vendor tokens.** Sealed with AES-256-GCM before they are written, with the
  additional authenticated data binding each ciphertext to one workspace and one
  grant, so a row copied between tenants does not decrypt. The key is not in the
  database.
- **`VAULT_KEY`.** The whole of the above depends on it. Anything that reveals
  it, including through an error message or a log line, is the most serious
  class of report this project can receive.
- **Tenant isolation.** A credential reaches one workspace. Anything that reads
  or writes across that line matters even when the data looks unimportant.
- **Gateway credentials.** Stored as a hash, shown once. A path that recovers a
  token from stored state is a real finding.
- **The scope gate.** A read-only credential is refused every write tool before
  the request reaches a vendor. A way past that is a finding even without data
  loss, because it is what makes handing an agent a read-only key mean anything.

## Already known

These are documented rather than undiscovered, so a report about them will be
closed with a link rather than an advisory.

- **A cross-origin redirect keeps the `Authorization` header**, filed as
  [#57](https://github.com/fajarhide/selat/issues/57). Every base URL in the
  registry is currently a constant chosen by this project, which is the only
  reason it is not already exploitable.
- **Local mode writes a vault key to `~/.selat/vault.key`** and a gateway
  credential beside it, both mode 600. That is deliberate: it is your own
  machine, and a key nobody can read again is the same as no key. A deployment
  sets `DATABASE_URL` and none of it happens.
- **A large download is stored for 24 hours** so the bytes stay out of a model.
  Scoped to the workspace and deleted with it, and described in the
  [privacy policy](https://selat.weekndlabs.com/privacy).
- **`GET /v1/catalog` needs no credential**, so a self-hosted instance
  advertises which OAuth applications it has configured and the tool names that
  follow from them. That is the point for a hosted gateway and a small
  disclosure for a private one. It carries no workspace, no connected account
  and no scope.
- **Providers below `ga` can change behaviour.** Nothing is `ga` yet, and the
  catalog says so per tool.

## Versions

The latest release is the supported one. There is no back-porting: this is one
maintainer and one moving version, and pretending otherwise would be a promise
nobody can keep.
