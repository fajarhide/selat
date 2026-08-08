import { GatewayError } from '../../domain/errors.ts'
import type { AdapterContext, ProviderAdapter, ToolDef, ToolResult } from './registry.ts'

const API = 'https://api.github.com'
const PAGE_SIZE = 30

const TOOLS: ToolDef[] = [
  {
    name: 'search_repositories',
    description: 'Search GitHub repositories with a query string, best match first',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GitHub search syntax, for example "mcp language:ts"' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page' },
      },
      required: ['query'],
    },
    write: false,
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page' },
      },
      required: ['owner', 'repo'],
    },
    write: false,
  },
  {
    name: 'get_issue',
    description: 'Fetch one issue by number from a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
      },
      required: ['owner', 'repo', 'number'],
    },
    write: false,
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository with a title and an optional body',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
    write: true,
  },
]

export function githubProvider(): ProviderAdapter {
  return {
    id: 'github',
    prefix: 'github',
    grantId: 'github',
    maturity: 'beta',
    scopes: ['repo', 'read:user'],
    listTools: () => TOOLS,

    async callTool(ctx, tool, rawArgs): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Record<string, string | number | undefined>
      const page = pageFrom(args.cursor)

      switch (tool) {
        case 'search_repositories': {
          const query = required(args.query, 'query')
          const url = `${API}/search/repositories?q=${encodeURIComponent(query)}&per_page=${PAGE_SIZE}&page=${page}`
          const body = await call<{ items: unknown[] }>(ctx, url)
          return paged(body.items, page)
        }
        case 'list_issues': {
          const owner = required(args.owner, 'owner')
          const repo = required(args.repo, 'repo')
          const state = args.state ?? 'open'
          const url = `${API}/repos/${segment(owner)}/${segment(repo)}/issues?state=${state}&per_page=${PAGE_SIZE}&page=${page}`
          const items = await call<unknown[]>(ctx, url)
          return paged(items, page)
        }
        case 'get_issue': {
          const owner = required(args.owner, 'owner')
          const repo = required(args.repo, 'repo')
          const number = required(args.number, 'number')
          return single(
            await call(ctx, `${API}/repos/${segment(owner)}/${segment(repo)}/issues/${segment(number)}`),
          )
        }
        case 'create_issue': {
          const owner = required(args.owner, 'owner')
          const repo = required(args.repo, 'repo')
          const title = required(args.title, 'title')
          return single(
            await call(ctx, `${API}/repos/${segment(owner)}/${segment(repo)}/issues`, {
              method: 'POST',
              body: JSON.stringify({ title, body: args.body ?? '' }),
            }),
          )
        }
        default:
          throw new GatewayError('tool_not_found', `github has no tool ${tool}`, {
            provider: 'github',
          })
      }
    },

    mapError(err) {
      if (err instanceof GatewayError) return err
      return new GatewayError('upstream_error', 'github request failed', { provider: 'github' })
    },
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === '') {
    throw new GatewayError('invalid_arguments', `${name} is required`, { provider: 'github' })
  }
  return value
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value))
}

function pageFrom(cursor: string | number | undefined): number {
  if (cursor === undefined) return 1
  const page = Number(cursor)
  if (!Number.isInteger(page) || page < 1) {
    throw new GatewayError('invalid_arguments', 'cursor is not a cursor this provider issued', {
      provider: 'github',
    })
  }
  return page
}

// The cursor is the next page number, kept opaque so the scheme can change
// without breaking an agent that stored one.
function paged(items: unknown[], page: number): ToolResult {
  const hasMore = items.length === PAGE_SIZE
  return { content: { items }, nextCursor: hasMore ? String(page + 1) : null, hasMore }
}

function single(content: unknown): ToolResult {
  return { content, nextCursor: null, hasMore: false }
}

async function call<T>(ctx: AdapterContext, url: string, init: RequestInit = {}): Promise<T> {
  const res = await ctx.fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${ctx.accessToken}`,
      'x-request-id': ctx.requestId,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })

  if (res.status === 401 || res.status === 403) {
    // GitHub answers 403 for both a rate limit and a permission problem, and
    // only the remaining header separates them. Getting this wrong sends the
    // user to reconnect a grant that was never broken.
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      throw new GatewayError('rate_limited', 'github rate limit reached', {
        provider: 'github',
        retryAfter: retryAfterFrom(res),
      })
    }
    throw new GatewayError('reauth_required', 'github rejected the credential', {
      provider: 'github',
    })
  }
  if (res.status === 429) {
    throw new GatewayError('rate_limited', 'github asked us to slow down', {
      provider: 'github',
      retryAfter: retryAfterFrom(res),
    })
  }
  if (!res.ok) {
    throw new GatewayError('upstream_error', `github returned ${res.status}`, { provider: 'github' })
  }
  return (await res.json()) as T
}

function retryAfterFrom(res: Response): number {
  const header = Number(res.headers.get('retry-after'))
  if (Number.isFinite(header) && header > 0) return header
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(1, Math.ceil(reset - Date.now() / 1000))
  }
  return 60
}
