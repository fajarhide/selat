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
  filter: { provider?: string; includeDisabled?: boolean } = {},
): Promise<{ tools: NamespacedTool[]; truncated: boolean }> {
  const enabled = new Set(await deps.enablement.enabledPrefixes(workspaceId))
  const disabled = await deps.enablement.disabledTools(workspaceId)

  const all: NamespacedTool[] = []
  for (const adapter of deps.registry.all()) {
    if (!enabled.has(adapter.prefix)) continue
    if (filter.provider && filter.provider !== adapter.prefix) continue
    for (const tool of adapter.listTools()) {
      const name = formatToolName(adapter.prefix, tool.name)
      const off = disabled.has(name)
      if (off && !filter.includeDisabled) continue
      all.push({
        ...tool,
        name,
        provider: adapter.prefix,
        maturity: adapter.maturity,
        ...(filter.includeDisabled ? { enabled: !off } : {}),
      })
    }
  }

  return { tools: all.slice(0, TOOL_BUDGET), truncated: all.length > TOOL_BUDGET }
}
