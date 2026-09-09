import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@forgeax/agent-runtime';
import { parseRuleString } from '@forgeax/types';
import type { AgentInstance } from '../src/runtime/types';
import type { AgentTemplateCatalog } from '../src/agents/agent-template-catalog';
import { RuntimeConfigBinding } from '../src/runtime/runtime-config';
import { agentToolPermissions, delegatedPermissionParent, pinAgentPermissions, resolveAgentPermissions, withAgentPermissionParent } from '../src/kernel/agent-permissions';
import type { Event } from '../src/core/types';
import type { DelegationInfo } from '../src/core/session';
import { writeKernelPermissions } from '../src/kernel/permission-config';
import { checkKernelTool } from '../src/kernel/trust-gate';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'child-permissions-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function family(mode?: PermissionMode) {
  const nodes = new Map<string, AgentInstance>();
  const entries = new Map<string, { trust: 'own' | 'imported' }>();
  const add = (id: string, parent: string | null, trust: 'own' | 'imported', permissionMode?: PermissionMode) => {
    const node = {
      sid: 'session-A', instanceId: id, runtimeEpochId: `epoch_${id}`, parentInstanceId: parent, templateRef: `tpl_${id}`,
      template: { definition: { id, kernelId: 'forgeax-core' } },
      runtimeConfig: new RuntimeConfigBinding({ revision: 'initial', value: { permissionMode } }),
    } as AgentInstance;
    nodes.set(id, node);
    entries.set(node.templateRef, { trust });
    return node;
  };
  const parent = add('forge', null, 'own', mode);
  const child = add('suzu', 'forge', 'imported');
  const grandchild = add('worker', 'suzu', 'imported');
  const session = {
    runtimeTree: { get: (id: string) => nodes.get(id) },
    templateCatalog: { get: (id: string) => entries.get(id) } as Pick<AgentTemplateCatalog, 'get'>,
  };
  const permissions = (node: AgentInstance) => resolveAgentPermissions(session, node, root);
  const gate = (node: AgentInstance, tool = 'write_file', extra = {}) => checkKernelTool(
    entries.get(node.templateRef)!.trust, tool,
    { projectRoot: root, args: { path: 'outside-game/file.txt' }, ...permissions(node), ...extra },
  );
  return { add, parent, child, grandchild, nodes, entries, session, permissions, gate };
}

describe('live child execution permissions without provenance promotion', () => {
  test('own parent and imported child/grandchild have the same write approval, including outside game', () => {
    const f = family('unrestricted');
    for (const node of [f.parent, f.child, f.grandchild]) expect(f.gate(node).outcome).toBe('allow');
    expect(f.entries.get(f.child.templateRef)?.trust).toBe('imported');
    expect(f.permissions(f.grandchild)).toEqual({ permissionMode: 'unrestricted', permissionBaseline: 'own' });
  });
  test.each(['gated', 'autoEdits', 'planning', 'unrestricted'] as const)('explicit child %s is inherited by grandchildren', mode => {
    const f = family('unrestricted');
    f.child.runtimeConfig.stage({ revision: 'override', value: { permissionMode: mode } });
    f.child.runtimeConfig.pinForTurn();
    expect(f.permissions(f.child).permissionMode).toBe(mode);
    expect(f.permissions(f.grandchild).permissionMode).toBe(mode);
    expect(f.gate(f.grandchild).outcome).toBe(mode === 'planning' ? 'deny' : mode === 'gated' ? 'ask' : 'allow');
  });
  test('grandchild override wins over child and root', () => {
    const f = family('planning');
    const node = f.add('explicit', 'suzu', 'imported', 'gated');
    expect(f.permissions(node).permissionMode).toBe('gated');
    expect(f.gate(node).outcome).toBe('ask');
  });
  test('unrelated npm root stays imported and asks; its child cannot borrow another root', () => {
    const f = family('unrestricted');
    const unrelated = f.add('npm-root', null, 'imported');
    const nested = f.add('npm-child', 'npm-root', 'own');
    expect(f.gate(unrelated).outcome).toBe('ask');
    expect(f.gate(nested).outcome).toBe('ask');
    expect(f.permissions(nested).permissionBaseline).toBe('imported');
  });
  test('standing mode of actual parent kernel reaches a child using a different kernel', () => {
    const f = family();
    writeKernelPermissions({ perKernel: { codex: 'gated', 'forgeax-core': 'unrestricted' } }, root);
    pinAgentPermissions(f.session, f.parent, root, 'codex');
    expect(pinAgentPermissions(f.session, f.child, root, 'forgeax-core').permissionMode).toBe('gated');
  });
  test('staged changes do not mutate a pinned child turn; next composition refreshes', () => {
    const f = family('unrestricted');
    pinAgentPermissions(f.session, f.child, root, 'forgeax-core');
    f.child.runtimeConfig.stage({ revision: 'next', value: { permissionMode: 'planning' } });
    expect(agentToolPermissions(f.session, f.child, root).permissionMode).toBe('unrestricted');
    f.child.runtimeConfig.pinForTurn();
    expect(pinAgentPermissions(f.session, f.child, root, 'forgeax-core').permissionMode).toBe('planning');
    expect(agentToolPermissions(f.session, f.child, root).permissionMode).toBe('planning');
  });
  test('source credential deny and unresolvable path deny survive inherited baseline', () => {
    const f = family('unrestricted');
    expect(f.gate(f.child, 'get_secret').outcome).toBe('deny');
    expect(f.gate(f.child, 'write_file', { args: {} }).outcome).toBe('deny');
    expect(f.gate(f.child, 'delete_file').outcome).toBe('ask');
  });
  test('deny and ask rules survive; planning deny precedes ask and allow', () => {
    const f = family('unrestricted');
    for (const behavior of ['deny', 'ask', 'allow'] as const) {
      const rules = { deny: [], ask: [], allow: [], [behavior]: [parseRuleString('write_file', behavior, 'test')!] };
      expect(f.gate(f.child, 'write_file', { rules }).outcome).toBe(behavior);
      expect(f.gate(f.child, 'write_file', { rules, permissionMode: 'planning' }).outcome).toBe('deny');
    }
  });
  test('autoEdits allows writes but still asks for shell; gated asks for writes', () => {
    const f = family('autoEdits');
    expect(f.gate(f.child).outcome).toBe('allow');
    expect(f.gate(f.child, 'bash').outcome).toBe('ask');
  });
  test('own unrestricted preserves delete/credential asks', () => {
    const f = family('unrestricted');
    expect(f.gate(f.parent, 'delete_file').outcome).toBe('ask');
    expect(f.gate(f.parent, 'get_secret').outcome).toBe('ask');
  });
  test('missing parent, missing catalog and cross-session parent fail closed even after pinning', () => {
    const f = family('unrestricted');
    pinAgentPermissions(f.session, f.child, root, 'forgeax-core');
    f.nodes.delete('forge');
    expect(() => agentToolPermissions(f.session, f.child, root)).toThrow('parent unavailable');
    f.nodes.set('forge', { ...f.parent, sid: 'other-session' });
    expect(() => f.permissions(f.child)).toThrow();
    f.nodes.set('forge', f.parent);
    f.entries.delete(f.parent.templateRef);
    expect(() => agentToolPermissions(f.session, f.child, root)).toThrow('template unavailable');
  });
  test('invalid explicit mode cannot silently fall back to unrestricted', () => {
    const f = family();
    f.child.runtimeConfig.stage({ revision: 'invalid', value: { permissionMode: 'typo' as PermissionMode } });
    f.child.runtimeConfig.pinForTurn();
    expect(() => f.permissions(f.child)).toThrow('invalid agent permissionMode');
  });

  test('host receipt gives a root specialist only turn-scoped inheritance; explicit override still wins', async () => {
    const f = family('unrestricted');
    const specialist = f.add('peer-suzu', null, 'imported');
    const receipt: DelegationInfo = {
      delegator: 'forge', brief: 'write', ts: 0, delegationId: 'd1',
      sourceEventId: 'event1', turnId: 'delegation:d1',
      targetInstanceId: specialist.instanceId, targetRuntimeEpochId: specialist.runtimeEpochId,
    };
    const host = {
      tree: { addressOf: (node: AgentInstance) => node.instanceId, resolve: (id: string) => f.nodes.get(id) },
      delegations: new Map([[specialist.instanceId, receipt]]),
    };
    const event: Event = {
      eventId: 'event1', source: 'agent:forge', type: 'message', ts: 0,
      to: 'agent:peer-suzu', handoff: 'turn',
      payload: { delegationId: 'd1', turnId: 'delegation:d1' },
    };
    const parent = delegatedPermissionParent(host, specialist, event);
    expect(parent).toBe(f.parent);
    await withAgentPermissionParent(specialist, parent, async () => {
      expect(pinAgentPermissions(f.session, specialist, root, 'forgeax-core').permissionBaseline).toBe('own');
      expect(checkKernelTool('imported', 'write_file', {
        ...agentToolPermissions(f.session, specialist, root), projectRoot: root, args: { path: 'src/output.txt' },
      }).outcome).toBe('allow');
      const nested = f.add('peer-worker', 'peer-suzu', 'imported');
      expect(f.permissions(nested).permissionBaseline).toBe('own');
    });
    expect(agentToolPermissions(f.session, specialist, root).permissionBaseline).toBe('imported');
    expect(f.gate(specialist).outcome).toBe('ask');
    specialist.runtimeConfig.stage({ revision: 'explicit', value: { permissionMode: 'planning' } });
    specialist.runtimeConfig.pinForTurn();
    await withAgentPermissionParent(specialist, parent, async () => {
      expect(pinAgentPermissions(f.session, specialist, root, 'forgeax-core').permissionMode).toBe('planning');
      expect(f.gate(specialist).outcome).toBe('deny');
    });
    for (const key of ['sourceEventId', 'turnId', 'delegationId', 'targetInstanceId', 'targetRuntimeEpochId'] as const) {
      host.delegations.set(specialist.instanceId, { ...receipt, [key]: 'stale' });
      expect(delegatedPermissionParent(host, specialist, event)).toBeUndefined();
    }
    host.delegations.clear();
    expect(delegatedPermissionParent(host, specialist, event)).toBeUndefined();
  });
});
