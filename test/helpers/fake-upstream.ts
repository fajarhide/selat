export type Route = {
  match: RegExp
  status?: number
  body?: unknown
  /** Sent verbatim instead of body, for a route that answers something other
   *  than JSON. */
  raw?: string
  headers?: Record<string, string>
}

export type FakeUpstream = {
  fetch: typeof fetch
  calls: { url: string; init?: RequestInit }[]
}

/** A fetch double, so an adapter can be driven with no network at all. */
export function fakeUpstream(routes: Route[]): FakeUpstream {
  const calls: FakeUpstream['calls'] = []
  const doFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const route = routes.find((candidate) => candidate.match.test(url))
    if (!route) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 })
    const status = route.status ?? 200
    // A 204 or 304 must be constructed with a null body or Response throws,
    // and those are the statuses a real delete answers with.
    const body = status === 204 || status === 304 ? null : (route.raw ?? JSON.stringify(route.body))
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    })
  }) as typeof fetch
  return { fetch: doFetch, calls }
}

export function itemsPage(count: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: index + 1 }))
}
