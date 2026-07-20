import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  acquireUiLease,
  clearUiStateForSession,
  firstClassUiToolSpecs,
  getUiAction,
  isUiActionRuntimeAvailable,
  resolveFirstClassUiTool,
  setUiManifest,
} from '../src/api/lib/ui-manifest-registry';
import { catalogGet, buildActionCatalog, type ActionCapability } from '../src/kernel/action-catalog';
import {
  preflightUiToolDispatch,
  runForgeaxBuiltinTool,
} from '../src/kernel/forgeax-builtin-tools';
import { makeInProcessExecuteTool } from '../src/kernel/host-tool-bridge';
import { getBuiltinHeadlessUiAction } from '../src/kernel/ui-headless-actions';
import { checkKernelTool, type GateOutcome } from '../src/kernel/trust-gate';
import { initOrchestrationSeams, resetOrchestrationSeams } from '../src/orchestration-seams';

type TrustTier = 'own' | 'imported';
type Lifecycle = 'cold-start' | 'restart';

interface CapabilityCase {
  capability: Extract<ActionCapability, 'read' | 'write' | 'delete'>;
  actionId: string;
  toolName: string;
  outcomes: Record<TrustTier, GateOutcome>;
}

const CAPABILITY_CASES: readonly CapabilityCase[] = [
  {
    capability: 'read',
    actionId: 'role.list',
    toolName: 'ui_act_role_list',
    outcomes: { own: 'allow', imported: 'allow' },
  },
  {
    capability: 'write',
    actionId: 'session.create',
    toolName: 'ui_act_session_create',
    outcomes: { own: 'allow', imported: 'ask' },
  },
  {
    capability: 'delete',
    actionId: 'session.close',
    toolName: 'ui_act_session_close',
    outcomes: { own: 'ask', imported: 'ask' },
  },
];

const TIERS: readonly TrustTier[] = ['own', 'imported'];
const LIFECYCLES: readonly Lifecycle[] = ['cold-start', 'restart'];
const MATRIX_ROWS = TIERS.flatMap((tier) =>
  CAPABILITY_CASES.flatMap((capabilityCase) =>
    LIFECYCLES.map((lifecycle) => ({ tier, capabilityCase, lifecycle })),
  ),
);
const usedSids = new Set<string>();
let sidSequence = 0;

function nextSid(label: string): string {
  sidSequence += 1;
  const sid = `r4-action-catalog-${label}-${process.pid}-${sidSequence}`;
  usedSids.add(sid);
  return sid;
}

function seedRuntimeBinding(sid: string, actionId: string): void {
  const entry = catalogGet(actionId);
  if (!entry) throw new Error(`missing catalog fixture ${actionId}`);
  const lease = acquireUiLease(sid, 'pre-restart-ui').leaseId;
  expect(
    setUiManifest(
      sid,
      [{ id: entry.id, title: entry.title, capability: entry.capability, surface: entry.surface }],
      lease,
    ),
  ).toMatchObject({ ok: true, accepted: 1, dropped: 0 });
  expect(isUiActionRuntimeAvailable(sid, actionId)).toBe(true);
}

function prepareLifecycle(lifecycle: Lifecycle, actionId: string): string {
  const sid = nextSid(`${lifecycle}-${actionId.replaceAll('.', '-')}`);
  buildActionCatalog();
  if (lifecycle === 'restart') {
    seedRuntimeBinding(sid, actionId);
    buildActionCatalog();
    clearUiStateForSession(sid);
    resetOrchestrationSeams();
  }
  expect(isUiActionRuntimeAvailable(sid, actionId)).toBe(false);
  return sid;
}

function installHeadlessProbe(actionId: string): { calls: () => number } {
  let callCount = 0;
  initOrchestrationSeams({
    hostUiActions: [
      {
        actionId,
        run: (args) => {
          callCount += 1;
          return { status: 'completed', stateDigest: { actionId, args } };
        },
      },
    ],
  });
  return { calls: () => callCount };
}

beforeEach(() => {
  buildActionCatalog();
  resetOrchestrationSeams();
});

afterEach(() => {
  for (const sid of usedSids) clearUiStateForSession(sid);
  usedSids.clear();
  resetOrchestrationSeams();
  buildActionCatalog();
});

describe('ActionCatalog trust matrix', () => {
  for (const [index, row] of MATRIX_ROWS.entries()) {
    const { tier, capabilityCase, lifecycle } = row;
    const caseNumber = String(index + 1).padStart(2, '0');
    const { actionId, capability, toolName } = capabilityCase;
    const expectedOutcome = capabilityCase.outcomes[tier];

    test(
      `[${caseNumber}/12] ${tier} x ${capability} x ${lifecycle} -> ${expectedOutcome} (${actionId})`,
      async () => {
        const sid = prepareLifecycle(lifecycle, actionId);
        expect(catalogGet(actionId)).toMatchObject({
          id: actionId,
          capability,
          surface: 'both',
          firstClass: true,
        });
        expect(firstClassUiToolSpecs(sid).some((spec) => spec.name === toolName)).toBe(true);
        expect(resolveFirstClassUiTool(sid, toolName)).toEqual({ actionId });

        const preflight = preflightUiToolDispatch(toolName, {}, sid);
        expect(preflight).toEqual({
          name: 'ui_invoke',
          args: { actionId, args: {} },
        });
        const decision = checkKernelTool(tier, preflight.name, { sid, args: preflight.args });
        expect(decision).toMatchObject({
          outcome: expectedOutcome,
          capability,
          allow: expectedOutcome === 'allow',
        });

        // Execution is checked after policy; ask rows model an approved prompt.
        expect(getBuiltinHeadlessUiAction(actionId)).toBeDefined();
        const handler = installHeadlessProbe(actionId);
        let publishes = 0;
        const result = await runForgeaxBuiltinTool(
          preflight.name,
          preflight.args as Record<string, unknown>,
          {
            projectRoot: '/tmp',
            agentId: 'forge',
            sid,
            eventBus: { publish: () => publishes++ },
          },
        );
        expect(result).toEqual({
          status: 'completed',
          stateDigest: { actionId, args: {} },
          executedVia: 'headless',
        });
        expect(handler.calls()).toBe(1);
        expect(publishes).toBe(0);
      },
    );
  }
});

describe('ActionCatalog cross-cutting invariants', () => {
  for (const lifecycle of LIFECYCLES) {
    test(`delegate supplement remains catalog-driven after ${lifecycle}`, async () => {
      const actionId = 'role.create';
      const toolName = 'ui_act_role_create';
      const sid = prepareLifecycle(lifecycle, actionId);
      const preflight = preflightUiToolDispatch(toolName, { id: 'probe', persona: 'Probe' }, sid);
      expect(catalogGet(actionId)).toMatchObject({
        capability: 'delegate',
        surface: 'both',
        firstClass: true,
      });
      expect(preflight).toEqual({
        name: 'ui_invoke',
        args: { actionId, args: { id: 'probe', persona: 'Probe' } },
      });
      expect(checkKernelTool('own', preflight.name, { sid, args: preflight.args })).toMatchObject({
        outcome: 'allow',
        capability: 'delegate',
      });
      expect(checkKernelTool('imported', preflight.name, { sid, args: preflight.args })).toMatchObject({
        outcome: 'ask',
        capability: 'delegate',
      });

      expect(getBuiltinHeadlessUiAction(actionId)).toBeDefined();
      const handler = installHeadlessProbe(actionId);
      const result = await runForgeaxBuiltinTool(
        preflight.name,
        preflight.args as Record<string, unknown>,
        { projectRoot: '/tmp', agentId: 'forge', sid },
      );
      expect(result).toMatchObject({ status: 'completed', executedVia: 'headless' });
      expect(handler.calls()).toBe(1);
    });
  }

  test('UI manifest tampering cannot add an action or rewrite catalog policy', () => {
    const sid = nextSid('tamper');
    const lease = acquireUiLease(sid, 'tampering-ui').leaseId;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        setUiManifest(
          sid,
          [
            {
              id: 'role.list',
              title: 'Forged role list',
              capability: 'delete',
              surface: 'server',
              firstClass: false,
            },
            { id: 'outside.catalog', title: 'Forged action', capability: 'read', surface: 'both' },
          ],
          lease,
        ),
      ).toMatchObject({ ok: true, accepted: 1, dropped: 1 });
      expect(getUiAction(sid, 'role.list')).toMatchObject({
        capability: 'read',
        surface: 'both',
        firstClass: true,
      });
      expect(getUiAction(sid, 'outside.catalog')).toBeUndefined();
      expect(checkKernelTool('imported', 'ui_invoke', { sid, args: { actionId: 'role.list' } })).toMatchObject({
        outcome: 'allow',
        capability: 'read',
      });
      const audit = warn.mock.calls.flat().join('\n');
      expect(audit).toContain('outside.catalog');
      expect(audit).toContain('capability');
      expect(audit).toContain('surface');
    } finally {
      warn.mockRestore();
    }
  });

  test("surface 'ui' stays unavailable without a live UI executor", async () => {
    const actionId = 'role.open';
    const sid = prepareLifecycle('cold-start', actionId);
    expect(catalogGet(actionId)).toMatchObject({ surface: 'ui' });
    expect(getBuiltinHeadlessUiAction(actionId)).toBeUndefined();
    const handler = installHeadlessProbe(actionId);
    let publishes = 0;
    const result = await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId, args: {} },
      {
        projectRoot: '/tmp',
        agentId: 'forge',
        sid,
        eventBus: { publish: () => publishes++ },
      },
    );
    expect(result).toEqual({
      unavailable: true,
      reason: 'no live UI executor binding for action "role.open"',
    });
    expect(handler.calls()).toBe(0);
    expect(publishes).toBe(0);
  });

  test("surface 'both' uses a server handler when no UI executor is live", async () => {
    const actionId = 'role.list';
    const sid = prepareLifecycle('cold-start', actionId);
    const handler = installHeadlessProbe(actionId);
    let publishes = 0;
    const result = await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId, args: {} },
      {
        projectRoot: '/tmp',
        agentId: 'forge',
        sid,
        eventBus: { publish: () => publishes++ },
      },
    );
    expect(result).toEqual({
      status: 'completed',
      stateDigest: { actionId, args: {} },
      executedVia: 'headless',
    });
    expect(handler.calls()).toBe(1);
    expect(publishes).toBe(0);
  });

  test('missing declarations return not_found before the trust gate', async () => {
    const sid = nextSid('not-found');
    let gateCalls = 0;
    const bridge = makeInProcessExecuteTool('forge', {
      checkKernelTool: (...args) => {
        gateCalls += 1;
        return checkKernelTool(...args);
      },
    });
    expect(await bridge('ui_invoke', { actionId: 'missing.action', args: {} }, sid)).toEqual({
      status: 'rejected',
      code: 'not_found',
      reason: 'action "missing.action" not in server ActionCatalog',
    });
    expect(await bridge('ui_act_missing_action', {}, sid)).toEqual({
      status: 'rejected',
      code: 'not_found',
      reason: 'action "ui_act_missing_action" not in server ActionCatalog',
    });
    expect(gateCalls).toBe(0);
  });
});
