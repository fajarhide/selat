import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

// Annotated rather than `satisfies`: inside an array literal TypeScript
// normalises the tool types into a union, which adds `owner?: undefined` to
// every tool and breaks the `Record<string, ArgDef>` index signature.
export const githubManifest: ProviderManifest = {
  id: 'github',
  prefix: 'github',
  maturity: 'beta',
  baseUrl: 'https://api.github.com',
  scopes: ['repo', 'read:user'],
  auth: { type: 'bearer' },
  headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  pagination: { style: 'page', size: 30, sizeParam: 'per_page', pageParam: 'page' },
  errors: {
    // GitHub answers 403 for both a rate limit and a permission problem, and
    // only the remaining header separates them. Getting this wrong sends the
    // user to reconnect a grant that was never broken.
    rateLimited: { status: 403, header: 'x-ratelimit-remaining', equals: '0' },
    // Ordered: retry-after is a delta, x-ratelimit-reset is an epoch second.
    retryAfter: [
      { header: 'retry-after', as: 'seconds' },
      { header: 'x-ratelimit-reset', as: 'epoch' },
    ],
  },
  tools: [
    {
      name: 'search_repositories',
      description: 'Search GitHub repositories with a query string, best match first',
      write: false,
      request: 'GET /search/repositories',
      args: {
        query: {
          type: 'string',
          description: 'GitHub search syntax, for example "mcp language:ts"',
          required: true,
          param: 'q',
        },
      },
      items: 'items',
      fields: ['full_name', 'description', 'stargazers_count', 'language', 'html_url'],
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository, optionally filtered by state',
      write: false,
      request: 'GET /repos/{owner}/{repo}/issues',
      args: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      },
      items: '$',
      fields: ['number', 'title', 'state', 'user.login', 'updated_at'],
    },
    {
      name: 'get_issue',
      description: 'Fetch one issue by number from a repository',
      write: false,
      request: 'GET /repos/{owner}/{repo}/issues/{number}',
      args: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        number: { type: 'number', required: true },
      },
      fields: ['number', 'title', 'state', 'body', 'user.login', 'html_url', 'updated_at'],
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository with a title and an optional body',
      write: true,
      request: 'POST /repos/{owner}/{repo}/issues',
      args: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        title: { type: 'string', required: true },
        body: { type: 'string' },
      },
      fields: ['number', 'title', 'state', 'html_url'],
    },
  ],
}

export function githubProvider(): ProviderAdapter {
  return manifestProvider(githubManifest)
}
