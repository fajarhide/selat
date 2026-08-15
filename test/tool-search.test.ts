import { describe, expect, it } from 'vitest'
import { searchTools } from '../src/application/tool-search.ts'
import type { NamespacedTool } from '../src/application/catalog.ts'

function tool(name: string, description: string): NamespacedTool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    write: false,
    provider: name.split('__')[0] ?? 'x',
    maturity: 'beta',
  }
}

const catalog = [
  tool('github__create_issue', 'Create an issue in a repository'),
  tool('github__list_issues', 'List issues in a repository'),
  tool('jira__add_comment', 'Comment on an existing issue'),
  tool('slack__post_message', 'Post a message to one channel'),
]

describe('searchTools', () => {
  it('ranks a name match above a description match', () => {
    const hits = searchTools(catalog, 'create issue', 10)
    // create_issue scores on both terms in the name; add_comment only mentions
    // "issue" in its description.
    expect(hits[0]?.name).toBe('github__create_issue')
    expect(hits.map((hit) => hit.name)).toContain('jira__add_comment')
  })

  it('returns a tool matched only by its description', () => {
    expect(searchTools(catalog, 'channel', 10).map((hit) => hit.name)).toEqual([
      'slack__post_message',
    ])
  })

  it('scores every term, so a more specific query wins', () => {
    const hits = searchTools(catalog, 'list issues repository', 10)
    expect(hits[0]?.name).toBe('github__list_issues')
  })

  it('honours the limit', () => {
    expect(searchTools(catalog, 'issue', 2)).toHaveLength(2)
  })

  it('returns nothing for a query that matches nothing, and for an empty one', () => {
    expect(searchTools(catalog, 'kubernetes', 10)).toEqual([])
    expect(searchTools(catalog, '   ', 10)).toEqual([])
  })

  it('orders equal scores by name, so the same query gives the same answer twice', () => {
    const tied = [tool('b__thing', 'the same words here'), tool('a__thing', 'the same words here')]
    const once = searchTools(tied, 'same words', 10).map((hit) => hit.name)
    const twice = searchTools([...tied].reverse(), 'same words', 10).map((hit) => hit.name)
    expect(once).toEqual(['a__thing', 'b__thing'])
    expect(twice).toEqual(once)
  })
})
