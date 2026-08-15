import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

export const notionManifest: ProviderManifest = {
  id: 'notion',
  prefix: 'notion',
  maturity: 'experimental',
  baseUrl: 'https://api.notion.com',
  // Notion grants capabilities on the integration itself rather than scopes on
  // the token, so there is nothing to ask for here.
  scopes: [],
  auth: { type: 'bearer' },
  headers: { 'notion-version': '2022-06-28' },
  pagination: {
    style: 'cursor',
    size: 25,
    sizeParam: 'page_size',
    param: 'start_cursor',
    nextPath: 'next_cursor',
    hasMorePath: 'has_more',
  },
  tools: [
    {
      name: 'search',
      description: 'Search pages and databases the integration can see',
      write: false,
      request: 'POST /v1/search',
      args: {
        query: { type: 'string', description: 'Title text to match', required: true },
      },
      items: 'results',
      fields: ['id', 'object', 'url', 'last_edited_time'],
    },
    {
      name: 'get_page',
      description: 'Fetch one page by id, with its properties',
      write: false,
      request: 'GET /v1/pages/{page_id}',
      args: { page_id: { type: 'string', required: true } },
      fields: ['id', 'url', 'created_time', 'last_edited_time', 'properties'],
    },
    {
      name: 'list_users',
      description: 'List the users in the connected workspace',
      write: false,
      request: 'GET /v1/users',
      args: {},
      items: 'results',
      fields: ['id', 'name', 'type', 'person.email'],
    },
  ],
}

export function notionProvider(): ProviderAdapter {
  return manifestProvider(notionManifest)
}
