import { formatToolName } from '../domain/tool-names.ts'
import type { Maturity, Registry, ToolDef } from '../adapters/providers/registry.ts'
import type { EnablementStore } from '../ports/stores.ts'

// Agents degrade well before any API limit as the tool list grows, so the
// catalog is capped and the cap is reported rather than silently applied.
export const TOOL_BUDGET = 60

export type NamespacedTool = ToolDef & {
  provider: string
  maturity: Maturity
  /** Only set when the caller asked for disabled tools, so /v1/tools is unchanged. */
  enabled?: boolean
}

export type CatalogDeps = { registry: Registry; enablement: EnablementStore }

export async function listWorkspaceTools(
  deps: CatalogDeps,
  workspaceId: string,
  filter: { provider?: string; includeDisabled?: boolean; limit?: number | null } = {},
): Promise<{ tools: NamespacedTool[]; truncated: boolean }> {
  const enabled = new Set(await deps.enablement.enabledPrefixes(workspaceId))
  const disabled = await deps.enablement.disabledTools(workspaceId)

  const byProvider: NamespacedTool[][] = []
  for (const adapter of deps.registry.all()) {
    if (!enabled.has(adapter.prefix)) continue
    if (filter.provider && filter.provider !== adapter.prefix) continue
    const group: NamespacedTool[] = []
    for (const tool of adapter.listTools()) {
      const name = formatToolName(adapter.prefix, tool.name)
      const off = disabled.has(name)
      if (off && !filter.includeDisabled) continue
      group.push({
        ...tool,
        name,
        provider: adapter.prefix,
        maturity: adapter.maturity,
        ...(filter.includeDisabled ? { enabled: !off } : {}),
      })
    }
    if (group.length) byProvider.push(group)
  }

  const all = interleave(byProvider)
  // undefined is the budget, which is every caller that does not care. null is
  // no cap at all, which the admin plane needs so tool 61 stays manageable.
  const limit = filter.limit === undefined ? TOOL_BUDGET : filter.limit
  if (limit === null) return { tools: all, truncated: false }
  return { tools: all.slice(0, limit), truncated: all.length > limit }
}

/**
 * One tool from each provider in turn. A plain concatenation is sliced in
 * registry boot order, so the provider that boots first is listed whole and a
 * later one is starved or invisible, for a reason nobody could discover from
 * the outside. Search reaches whatever misses the cut, which is what makes an
 * even sample the right thing to list.
 */
function interleave(groups: NamespacedTool[][]): NamespacedTool[] {
  const out: NamespacedTool[] = []
  const longest = groups.reduce((max, group) => Math.max(max, group.length), 0)
  for (let index = 0; index < longest; index++) {
    for (const group of groups) {
      const tool = group[index]
      if (tool) out.push(tool)
    }
  }
  return out
}
