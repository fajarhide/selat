# Changelog

Notable changes, newest first. Dates are the day the work merged.

## Unreleased

### Fixed

- An id-paged provider can carry the vendor's own `has_more` instead of
  inferring from page fullness, which was wrong whenever a last page happened
  to be exactly full: the caller was told there was more and found nothing. A
  provider that sets nothing keeps inferring exactly as before (#69).

## 0.1.1 - 2026-08-23

### Added

- Credential scoping is documented. `{providers, readOnly}` has been enforced
  since before this changelog and appeared in no README (#65).
- `GET /v1/catalog`, unauthenticated, reporting what this deployment booted with
  the tool names it serves, so a site rendering a page per provider does not
  keep its own copy of the truth (#62).
- `upload_file` and `replace_file_content` take a file the gateway already
  holds, so a download and an upload join without either set of bytes reaching
  the conversation. Copying a large attachment between two vendors now costs
  two tool calls and no payload (#56).

- `SECURITY.md`, naming what is worth attacking in a gateway that holds other
  people's credentials, and which behaviours are known and deliberate so a
  report about one gets a link rather than an advisory (#58).

### Fixed

- A read-only credential is no longer shown the write tools it will be refused.
  Both tool lists filtered on the provider alone and ignored `readOnly`, so a
  Drive-scoped read-only credential was offered `delete_file` and found out by
  spending a turn on it. A tool is listed exactly when the same scope would let
  it be called (#64).
- A redirect to another origin no longer carries the credential. `fetch`
  followed redirects by default, so a 302 took the `Authorization` header
  wherever an upstream pointed, and an `api_key` provider its named header.
  Cross-origin redirects are still followed, because a Drive download answers
  with one (#57).

### Changed

- A download larger than 256 KB is stored and answered as a `file_id` rather
  than base64, and fetched at `GET /v1/files/{id}` with the same credential
  that made the call. Bytes stop passing through the model, so the ceiling on a
  download rises from 5 MB to 25 MB. Stored bytes live 24 hours, count against
  a per-workspace quota, and are deleted with the workspace (#42).

## 0.1.0 - 2026-08-23

First release on the registry. The version ran in production from 2026-08-17
before it got there, so the deployments and this repository's history carry it
earlier than npm does.

### Added

- `npx @fajarhide/selat`. With no `DATABASE_URL`, Selat runs Postgres in-process through
  PGlite and keeps its state in `~/.selat`, so trying it costs no database to
  install. The first run provisions a workspace and a credential, because
  without a service token the admin plane is not mounted and there would be no
  way to ask for one (#48).
- Google Drive can be written to, not only read: `create_folder`, `rename_file`,
  `move_file`, `copy_file`, `trash_file`, `delete_file` and `share_file`. The
  scope widened from `drive.readonly` to `drive`, so a connection made before
  this reconnects once (#35).
- `upload_file` and `replace_file_content`, sent as `multipart/related` so one
  call carries a file's name, folder and contents (#39).
- `download_file` and `export_file`. A tool can declare that its response is
  bytes; the result is base64 with its media type, capped at 5 MB, and the MCP
  surface hands text back as text and an image as an image block (#33).
- Pull requests are visible to the `github` provider: `list_pull_requests`,
  `get_pull_request`, `list_pull_request_comments`, `list_pull_request_reviews`
  and `list_check_runs` (#44).
- `labels` and `assignees` on `github__create_issue`, now that an argument can
  be a list (#34).

### Changed

- An argument can name where it travels, `query` or `body`, instead of the
  method deciding for it, and can hold a list of strings (#34).
- A caller who names the fields keeps them. When a tool declares a `selector`
  and the caller sets it, the manifest projection is skipped, because the
  upstream has already narrowed the response to what was asked for (#41).
- `Pool` is the five methods the codebase uses rather than `pg.Pool` outright,
  which is what lets a second implementation exist (#48).

### Fixed

- A write tool asks Drive for the fields it promises to return. `trash_file`
  declared `trashed` and could never return it, so it could trash a file and
  not say whether it had (#45).
- An empty `204` is read as an empty result rather than a parse failure.
  `delete_file` was the first tool in any provider to answer that way (#38).
