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
      name: 'get_authenticated_user',
      description: 'Read the account this connection belongs to, with its public counts',
      write: false,
      request: 'GET /user',
      args: {},
      fields: ['login', 'name', 'html_url', 'public_repos', 'created_at'],
    },
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
      name: 'list_pull_requests',
      description: 'List pull requests in a repository, optionally filtered by state',
      write: false,
      request: 'GET /repos/{owner}/{repo}/pulls',
      args: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      },
      items: '$',
      // head.sha is what list_check_runs keys on, so it travels with the row
      // rather than costing a second call to find it.
      fields: ['number', 'title', 'state', 'draft', 'user.login', 'head.sha', 'html_url', 'updated_at'],
    },
    {
      name: 'get_pull_request',
      description: 'Fetch one pull request, with whether it can merge and the head commit its checks run against',
      write: false,
      request: 'GET /repos/{owner}/{repo}/pulls/{number}',
      args: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        number: { type: 'number', required: true },
      },
      fields: [
        'number',
        'title',
        'state',
        'body',
        'draft',
        'user.login',
        'head.sha',
        'base.ref',
        'mergeable',
        'mergeable_state',
        'html_url',
        'updated_at',
      ],
    },
    {
      name: 'list_pull_request_comments',
      description: 'List the inline review comments on a pull request, the ones attached to a line of the diff',
      write: false,
      request: 'GET /repos/{owner}/{repo}/pulls/{number}/comments',
      args: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        number: { type: 'number', required: true },
      },
      items: '$',
      fields: ['id', 'user.login', 'path', 'line', 'body', 'created_at', 'html_url'],
    },
    {
      name: 'list_pull_request_reviews',
      description: 'List the reviews on a pull request, with each verdict and its summary comment',
      write: false,
      request: 'GET /repos/{owner}/{repo}/pulls/{number}/reviews',
      args: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        number: { type: 'number', required: true },
      },
      items: '$',
      // Separate from the inline comments on purpose: a verdict lives here and
      // the line it is about lives there, and reading one without the other is
      // how a real objection gets merged past.
      fields: ['id', 'user.login', 'state', 'body', 'submitted_at'],
    },
    {
      name: 'list_check_runs',
      description: 'List the check runs for one commit, which is how CI reports on a pull request. Use the head sha',
      write: false,
      request: 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      args: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        ref: { type: 'string', required: true, description: 'Commit sha, branch or tag' },
      },
      items: 'check_runs',
      fields: ['name', 'status', 'conclusion', 'started_at', 'completed_at', 'details_url'],
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
        labels: { type: 'string[]', description: 'Label names to apply' },
        assignees: { type: 'string[]', description: 'GitHub logins to assign' },
      },
      fields: ['number', 'title', 'state', 'html_url'],
    },
  ],
}

export function githubProvider(): ProviderAdapter {
  return manifestProvider(githubManifest)
}
