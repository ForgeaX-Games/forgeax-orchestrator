import type { PermissionMode, TrustTier } from '@forgeax/agent-runtime';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DelegationInfo } from '../core/session';
import type { Event } from '../core/types';
import { resolveTemplateTrust, type AgentTemplateCatalog } from '../agents/agent-template-catalog';
import type { RuntimeTree } from '../runtime/runtime-tree';
import type { AgentInstance } from '../runtime/types';
import { DEFAULT_KERNEL_PERMISSION_MODE, standingModeFor } from './permission-config';
import { parseAgentPermissionMode } from '../runtime/runtime-config';

export interface AgentPermissions {
  permissionMode: PermissionMode;
  /** Execution approval baseline only; never source identity or tool grants. */
  permissionBaseline: TrustTier;
}

interface PermissionSession {
  runtimeTree: Pick<RuntimeTree, 'get'>;
  templateCatalog: Pick<AgentTemplateCatalog, 'get'>;
}

// A parent's composed turn is the authority for its actual selected kernel,
// including per-turn kernel overrides. Weak keys cannot leak across sessions.
const turnPermissions = new WeakMap<AgentInstance, AgentPermissions>();
const permissionParent = new AsyncLocalStorage<{ instance: AgentInstance; parent: AgentInstance }>();

/** Existing root residents are peers on disk. Only a matching host-owned
 * delegation receipt grants them a parent for this execution, never forever. */
export function delegatedPermissionParent(
  session: {
    tree: { addressOf(instance: AgentInstance): string; resolve(address: string): AgentInstance | undefined };
    delegations: ReadonlyMap<string, DelegationInfo>;
  },
  instance: AgentInstance,
  event: Event,
): AgentInstance | undefined {
  if (instance.parentInstanceId !== null) return undefined;
  const receipt = session.delegations.get(session.tree.addressOf(instance));
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (!receipt?.delegationId || !receipt.sourceEventId || !receipt.turnId
    || receipt.targetInstanceId !== instance.instanceId
    || receipt.targetRuntimeEpochId !== instance.runtimeEpochId
    || receipt.sourceEventId !== event.eventId
    || receipt.delegationId !== payload.delegationId
    || receipt.turnId !== payload.turnId) return undefined;
  const parent = session.tree.resolve(receipt.delegator);
  if (!parent || parent.sid !== instance.sid || parent === instance) throw new Error('delegation permission parent unavailable');
  return parent;
}

export async function withAgentPermissionParent<T>(instance: AgentInstance, parent: AgentInstance | undefined, run: () => Promise<T>): Promise<T> {
  if (!parent) return run();
  try {
    return await permissionParent.run({ instance, parent }, run);
  } finally {
    // A delegated peer must not retain authority for later direct commands.
    turnPermissions.delete(instance);
  }
}

export function resolveAgentPermissions(
  session: PermissionSession,
  instance: AgentInstance,
  projectRoot: string,
  kernelId?: string,
): AgentPermissions {
  const scoped = permissionParent.getStore();
  const parentOf = (node: AgentInstance): AgentInstance | undefined => {
    if (scoped?.instance === node) return scoped.parent;
    if (node.parentInstanceId === null) return undefined;
    const parent = session.runtimeTree.get(node.parentInstanceId);
    if (!parent) throw new Error('permission parent unavailable');
    return parent;
  };
  const visited = new Set<string>();
  // Validate the whole authority chain even when an ancestor has a pinned turn.
  let cursor: AgentInstance | undefined = instance;
  while (cursor) {
    if (cursor.sid !== instance.sid || visited.has(cursor.instanceId)) throw new Error('invalid permission parent tree');
    visited.add(cursor.instanceId);
    if (!session.templateCatalog.get(cursor.templateRef)) throw new Error('permission template unavailable');
    cursor = parentOf(cursor);
  }
  visited.clear();
  const visit = (node: AgentInstance, selectedKernel?: string): AgentPermissions => {
    if (node.sid !== instance.sid || visited.has(node.instanceId)) throw new Error('invalid permission parent tree');
    visited.add(node.instanceId);
    const ownMode = node.runtimeConfig.current().value.permissionMode;
    const trust = resolveTemplateTrust(session.templateCatalog, node.templateRef);
    const parent = parentOf(node);
    if (parent) {
      if (!parent || parent.sid !== node.sid) throw new Error('permission parent unavailable');
      const inherited = turnPermissions.get(parent) ?? visit(parent);
      return {
        ...inherited,
        ...(ownMode !== undefined ? { permissionMode: parseAgentPermissionMode(ownMode) } : {}),
      };
    }
    return {
      permissionMode: ownMode !== undefined ? parseAgentPermissionMode(ownMode)
        : standingModeFor(selectedKernel ?? node.template.definition.kernelId ?? 'forgeax-core', projectRoot)
          ?? DEFAULT_KERNEL_PERMISSION_MODE,
      permissionBaseline: trust,
    };
  };
  return visit(instance, kernelId);
}

/** Pin once at composition; callbacks must use the same posture as the kernel. */
export function pinAgentPermissions(
  session: PermissionSession, instance: AgentInstance, projectRoot: string, kernelId: string,
): AgentPermissions {
  const permissions = resolveAgentPermissions(session, instance, projectRoot, kernelId);
  turnPermissions.set(instance, permissions);
  return permissions;
}

export function agentToolPermissions(
  session: PermissionSession, instance: AgentInstance | undefined, projectRoot: string,
): Partial<AgentPermissions> {
  return instance && session.runtimeTree
    ? resolvePinnedToolPermissions(session, instance, projectRoot)
    : {};
}

function resolvePinnedToolPermissions(session: PermissionSession, instance: AgentInstance, projectRoot: string): AgentPermissions {
  const current = resolveAgentPermissions(session, instance, projectRoot);
  return turnPermissions.get(instance) ?? current;
}
