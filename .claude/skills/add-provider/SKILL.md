---
name: add-provider
description: Turn a vendor's API documentation into a Selat provider manifest. Use when adding a new upstream, or when asked to widen an existing one.
---

# Adding a provider

A provider here is data. One generic executor makes the request, so what you
write is a `ProviderManifest`: a base URL, an auth scheme, and a few tools
naming their method, path, arguments and the fields worth keeping.

Read `src/adapters/providers/github.ts` first. It is short and it is the shape.

An OpenAPI importer was built for this and abandoned, because a spec does not
say how an endpoint paginates, which fields are worth keeping, or what a bare
403 means for that vendor. Those three are most of a manifest's value and they
come from reading prose. That is why this is instructions for a reader rather
than a program.

## What you must not do

These are the rules. Most were learned by shipping the mistake.

**Never name a field you have not seen.** `fields` may only list something that
appears in a response example in the vendor's documentation. `gdrive__trash_file`
declared `trashed` and could never return it, because Drive does not send that
field unless asked, so the tool could bin a file and not say whether it had. If
the docs show no response example, you have not read enough yet.

**`maturity` is always `experimental`.** You do not grade your own work. It
becomes `beta` when somebody runs it against the real vendor and says so. This
repository has never marked anything `ga`.

**Three to five tools, not the whole API.** Every listed tool costs a slot
against the sixty an agent is served, and a model chooses worse from a long
list. Pick what someone would actually call.

**Refuse rather than guess the paginator.** If the docs do not say how a list
endpoint pages, stop and say so. A wrong paginator silently truncates somebody's
data, which is worse than an absent tool.

**Write down what you did not find out.** In the pull request, not in a comment
nobody reads. "I did not add filters to `list_charges` because I did not read
the list parameters" is a useful sentence. Inventing three filters is not.

**Read-only unless the write is the point.** A `write: true` tool is refused to
read-only credentials, which is good, but it also means an agent can change
somebody's data. Earn it.

## The three things a spec cannot give you

Spend your reading here, because everything else is transcription.

**Pagination.** Find the list endpoint's parameters and its response envelope.
Then match it to one of three shapes:

- `page`: a page number goes up. `{style, size, sizeParam, pageParam}`
- `cursor`: the response hands back an opaque token. `{style, size, sizeParam,
  param, nextPath, hasMorePath?}`
- `id`: you send the id of the last item you saw. `{style, size, sizeParam,
  param, idPath?, hasMorePath?}`

If the response also states outright whether more exist, set `hasMorePath`.
Without it the executor infers from page fullness, and that is wrong whenever a
last page happens to be exactly full.

**Projection.** Look at one response object and count. If it has forty fields
and an agent needs eight, `fields` is the difference between a usable tool and
one that floods a context window. Dotted paths reach inside, so
`outcome.seller_message` is fine.

**What a bare 403 means.** Vendors disagree, and getting it wrong sends someone
to reconnect a credential that was never broken. Google answers 401 for a dead
credential and keeps 403 for an API that was never enabled. Stripe's 403 means
the key lacks permission. Both want `errors: { forbidden: 'upstream_error' }`.
A vendor that really does answer 403 for a revoked token wants the default.

## Then

Write a test beside the others in `test/providers/`. Run
`runAdapterConformance` for the paginated tool, and assert the three things you
inferred: that the paginator does what you said, that the projection drops what
you meant it to, and that the credential travels where the vendor wants it.

Prove the test can fail. Break the manifest, watch it go red, put it back, and
paste the red in the pull request. A check that cannot fail proves nothing.

If the manifest cannot express what the vendor needs, that is a gap in the
executor. Say so in an issue rather than working around it in one provider:
that is how `in: 'query'`, `string[]`, binary responses and uploads arrived.
