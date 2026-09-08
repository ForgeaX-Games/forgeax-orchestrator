/**
 * Provider tool-array budget.
 *
 * Azure / several OpenAI-compatible gateways reject `tools` longer than 128
 * (`Invalid 'tools': array too long`). First-class UI actions + extension
 * skills can push a turn over that cap and silently drop later tools — which
 * is how an extension generation tool disappears from chat.
 *
 * Trim from the end (skills and late extras) and never drop names in
 * `pinNames` (core builtins + plugin tools marked `pinned`).
 */
import { getExtensionSnapshot } from '../extensions/registry';

export const PROVIDER_TOOL_LIMIT = 128;

export function capToolsForProvider<T extends { name?: string }>(
  tools: T[],
  opts?: { limit?: number; pinNames?: Iterable<string> },
): T[] {
  const limit = opts?.limit ?? PROVIDER_TOOL_LIMIT;
  if (tools.length <= limit) return tools;
  const pin = new Set(opts?.pinNames ?? []);
  const droppable: number[] = [];
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const name = tools[i]?.name;
    if (!name || !pin.has(name)) droppable.push(i);
  }
  const dropCount = tools.length - limit;
  const drop = new Set(droppable.slice(0, dropCount));
  if (drop.size < dropCount) {
    const pinned = tools.filter((t) => !!t.name && pin.has(t.name));
    const rest = tools.filter((t) => !t.name || !pin.has(t.name));
    return [...pinned, ...rest].slice(0, limit);
  }
  return tools.filter((_, i) => !drop.has(i));
}

export function pinnedHostToolWireNames(): string[] {
  return getExtensionSnapshot()
    .kinds.tools.filter((t) => t.pinned)
    .map((t) => t.toolId.replace(/[^a-zA-Z0-9_-]/g, '_'));
}
