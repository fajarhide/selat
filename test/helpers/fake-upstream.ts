export type Route = {
  match: RegExp
  status?: number
  body: unknown
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
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    })
  }) as typeof fetch
  return { fetch: doFetch, calls }
}

export function itemsPage(count: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: index + 1 }))
}
