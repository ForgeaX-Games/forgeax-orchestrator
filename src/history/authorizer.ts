export type HistoryCapability = 'history.query' | 'history.export' | 'history.import';

export interface HistoryPrincipal {
  sid: string;
  agentId: string;
  capabilities: readonly HistoryCapability[];
}

/** Host-side authorization seam. Kernel code never receives this object. */
export function authorizeHistory(
  principal: HistoryPrincipal,
  requested: { sid: string; agentId: string; capability: HistoryCapability },
): void {
  if (
    principal.sid !== requested.sid ||
    principal.agentId !== requested.agentId ||
    !principal.capabilities.includes(requested.capability)
  ) throw new Error('history_permission_denied');
}
