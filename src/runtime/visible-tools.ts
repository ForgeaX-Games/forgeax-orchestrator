import type { AgentContext, ToolDefinition } from "../core/types";

/**
 * Return the tools visible to one live runtime host for this turn.
 *
 * Kit registries intentionally retain hidden entries so a config change can
 * be applied without rebuilding the registry. Callers that expose or execute
 * tools must come through this projection; using registry.list() directly is
 * an authority bypass.
 */
export function visibleTools(
  tools: readonly ToolDefinition[],
  context: AgentContext,
): ToolDefinition[] {
  const visible = tools.filter((tool) => {
    if (!tool.condition) return true;
    try {
      return tool.condition(context, tool);
    } catch {
      return false;
    }
  });
  const counts = new Map<string, number>();
  for (const tool of visible) {
    const name = bareName(tool.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return visible.filter((tool) => counts.get(bareName(tool.name)) === 1);
}

export function bareName(name: string): string {
  return name.includes("/") ? name.split("/").at(-1)! : name;
}
