import { describe, expect, it } from 'vitest'
import { formatToolName, parseToolName } from '../src/domain/tool-names.ts'
import { GatewayError } from '../src/domain/errors.ts'

describe('tool names', () => {
  it('round trips a simple name', () => {
    expect(formatToolName('jira', 'search')).toBe('jira__search')
    expect(parseToolName('jira__search')).toEqual({ prefix: 'jira', tool: 'search' })
  })

  it('keeps underscores inside the tool part', () => {
    expect(parseToolName('github__list_pull_requests')).toEqual({
      prefix: 'github',
      tool: 'list_pull_requests',
    })
  })

  it('splits on the first separator only, so a tool may contain one', () => {
    expect(parseToolName('gdrive__export__pdf')).toEqual({ prefix: 'gdrive', tool: 'export__pdf' })
  })

  it('rejects a name without a separator', () => {
    expect(() => parseToolName('search')).toThrowError(GatewayError)
  })

  it('rejects an empty prefix or tool', () => {
    expect(() => parseToolName('__search')).toThrowError(GatewayError)
    expect(() => parseToolName('jira__')).toThrowError(GatewayError)
  })

  it('rejects a prefix that is not lowercase alphanumeric', () => {
    expect(() => formatToolName('Ji ra', 'search')).toThrowError(GatewayError)
    expect(() => parseToolName('Jira__search')).toThrowError(GatewayError)
    expect(() => parseToolName('my-provider__search')).toThrowError(GatewayError)
  })

  it('reports tool_not_found rather than a generic failure', () => {
    try {
      parseToolName('search')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as GatewayError).code).toBe('tool_not_found')
    }
  })
})
