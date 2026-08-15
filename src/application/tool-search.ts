import type { NamespacedTool } from './catalog.ts'

const NAME_HIT = 3
const DESCRIPTION_HIT = 1

/**
 * A linear scan, on purpose. The enabled catalog of one workspace is small, and
 * an index would be a dependency plus an invalidation problem for a gain nobody
 * has measured. This should stay this size until a real query log says
 * otherwise.
 */
export function searchTools(
  tools: NamespacedTool[],
  query: string,
  limit: number,
): NamespacedTool[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (terms.length === 0) return []

  const scored: { tool: NamespacedTool; score: number }[] = []
  for (const tool of tools) {
    const name = tool.name.toLowerCase()
    const description = tool.description.toLowerCase()
    let score = 0
    for (const term of terms) {
      // A tool called create_issue is a better answer to "create issue" than
      // one that merely mentions issues in passing.
      if (name.includes(term)) score += NAME_HIT
      if (description.includes(term)) score += DESCRIPTION_HIT
    }
    if (score > 0) scored.push({ tool, score })
  }

  // Name as the tie break, so two equal scores come back in the same order
  // every time and a client can cache what it saw.
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
  return scored.slice(0, limit).map((row) => row.tool)
}
