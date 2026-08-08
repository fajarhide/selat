import { GatewayError } from './errors.ts'

export const TOOL_SEPARATOR = '__'

const PREFIX = /^[a-z][a-z0-9]*$/

export function formatToolName(prefix: string, tool: string): string {
  if (!PREFIX.test(prefix)) {
    throw new GatewayError('tool_not_found', `invalid provider prefix: ${prefix}`)
  }
  if (tool.length === 0) throw new GatewayError('tool_not_found', 'empty tool name')
  return `${prefix}${TOOL_SEPARATOR}${tool}`
}

export function parseToolName(name: string): { prefix: string; tool: string } {
  const at = name.indexOf(TOOL_SEPARATOR)
  if (at <= 0) throw new GatewayError('tool_not_found', `unqualified tool name: ${name}`)
  const prefix = name.slice(0, at)
  const tool = name.slice(at + TOOL_SEPARATOR.length)
  if (!PREFIX.test(prefix) || tool.length === 0) {
    throw new GatewayError('tool_not_found', `malformed tool name: ${name}`)
  }
  return { prefix, tool }
}
