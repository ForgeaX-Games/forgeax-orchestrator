/**
 * host-tool-bridge —— 编排层(cli)提供给「原生 in-process 内核」的 host 工具执行桥。
 *
 * 它把内核发起的工具调用接到 cli 的宿主能力上(与 `POST /:sid/kernel-tool` 同一信任闸口
 * T-D,免 HTTP):定位活 agent → Catalog 权威 trustTier → checkKernelTool →
 * (ask → 弹卡等用户)→ executeTool。
 *
 * 三档闸:allow 直跑;deny 抛;**ask 经 `requestToolApproval` 弹权限卡阻塞等用户**
 * (own 危险操作 / imported exec·network·游戏内写删 → 确认;命中本会话 remember 免卡)。
 * 这是 forgeax-core 默认内核唯一的交互式审批接入点(serve 的所有工具都回调到此)。
 *
 * DIP 边界:本桥**只依赖 cli 内部**(session / soul / trust-gate / tool-approval / tool-executor),
 * 不 import 任何具体内核包。产品壳(packages/server)在装配原生内核时复用本桥,从而 cli 不反向依赖内核实现。
 */
import { executionToolScope } from '../agents/execution-tool-scope';
import { getSessionManager } from '../core/session-manager';
import { checkKernelTool } from './trust-gate';
import { agentToolPermissions } from './agent-permissions';
import { loadSettingsPermissionRules } from '../api/lib/permission-settings';
import { requestToolApproval } from './tool-approval';
import { executeTool } from '../kits/tool/tool-executor';
import {
  isForgeaxBuiltinTool,
  runForgeaxBuiltinTool,
  hostToolRunCtx,
  preflightUiToolDispatch,
} from './forgeax-builtin-tools';
import { getHostTool } from '../orchestration-seams';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getPathManager } from '../fs/path-manager';
import { tt } from '../lib/turn-trace';
import { appendToolAudit } from './tool-audit';
import { shouldDelegateHostToolConfirmation } from './host-tool-confirmation';
import { runSkillKernelTool } from '../skills/kernel-tool-bridge';
import {
  createProjectMcpBridge,
  isProjectMcpToolName,
  ProjectMcpToolNotFoundError,
  type ProjectMcpBridge,
} from './project-mcp';
import { recordSessionHostToolWrites } from './host-tool-written-files';
import { resolveTemplateTrust } from '../agents/agent-template-catalog';
import { loadAgentRecord } from '../soul/soul-pack-loader';
import { visibleTools } from '../runtime/visible-tools';
import {
  filterVisibleAgentManagementTools,
  visibleAgentManagementToolsForAgent,
  type AgentManagementToolName,
} from '../kits/agent-management-visibility';
import { isBuiltinToolEnabled } from './builtin-tool-policy';
import { canonicalAgentManagementTool } from '../api/lib/host-tools-for-agent';
import { withAgentHostToolDefinitions } from '../tools/agent-host-tool-surface';

/** 与原生内核约定的 host 工具执行签名(结构化,不 import 内核包的类型)。
 *  `agentId` = 本轮真实发起工具的 agent(委派轮里即被委派方,如 mochi);缺省回落 defaultAgentPath。
 *  `callId` = 本轮工具调用 id(= tool.call/tool.result 的 callId);外部宿主(studio)据它把
 *  前端 HITL 卡片的 pending 表 key 钉在同一 id 上,使前端回填对得上。cli 内建桥不用它。 */
export type HostExecuteToolFn = (
  name: string,
  args: unknown,
  sid?: string,
  agentId?: string,
  callId?: string,
  turnCallId?: string,
) => Promise<unknown>;

/** 桥的可注入协作方(显式声明的输入,Pipeline Isolation)。生产路径全部省略 → 用真实 cli
 *  内部实现;单测可注入桩驱动各决策出口,免起活 session、零全局 mock。`appendToolAudit`
 *  始终走真实实现(其副作用即被断言的审计行)。 */
export interface HostToolBridgeDeps {
  getSessionManager: typeof getSessionManager;
  /** Legacy injectable loader retained for host-bridge audit fixtures. */
  loadAgentRecord: typeof loadAgentRecord;
  checkKernelTool: typeof checkKernelTool;
  shouldDelegateHostToolConfirmation: typeof shouldDelegateHostToolConfirmation;
  requestToolApproval: typeof requestToolApproval;
  executeTool: typeof executeTool;
  /** Test seam; production uses the shared pooled project-MCP bridge. */
  projectMcp: ProjectMcpBridge;
}

/** in-process host-tool 桥:与 `POST /:sid/kernel-tool` 同一信任闸口(T-D),免 HTTP。 */
export function makeInProcessExecuteTool(
  defaultAgentPath = 'forge',
  deps: Partial<HostToolBridgeDeps> = {},
): HostExecuteToolFn {
  const _getSessionManager = deps.getSessionManager ?? getSessionManager;
  const _loadAgentRecord = deps.loadAgentRecord ?? loadAgentRecord;
  const _checkKernelTool = deps.checkKernelTool ?? checkKernelTool;
  const _shouldDelegateHostToolConfirmation =
    deps.shouldDelegateHostToolConfirmation ?? shouldDelegateHostToolConfirmation;
  const _requestToolApproval = deps.requestToolApproval ?? requestToolApproval;
  const _executeTool = deps.executeTool ?? executeTool;
  const projectMcp = deps.projectMcp ?? createProjectMcpBridge(defaultProjectRoot());
  return async (
    name: string,
    args: unknown,
    sid?: string,
    agentId?: string,
    callId?: string,
    turnCallId?: string,
  ): Promise<unknown> => {
    const trace = {
      ...(callId?.trim() ? { callId: callId.trim() } : {}),
      ...(turnCallId?.trim() ? { turnCallId: turnCallId.trim() } : {}),
    };
    if (!sid) throw new Error('forgeax-core kernel: missing hostSessionId for host-tool bridge');
    // Normalize catalog-derived ui_act_* and reject missing declarations before trust policy.
    const requestedToolName = name;
    const preflight = preflightUiToolDispatch(name, args, sid);
    if (preflight.rejection) return preflight.rejection;
    name = preflight.name;
    args = preflight.args;
    // 审计同 `POST /:sid/kernel-tool`:单 start 计 durationMs,每个决策出口恰追加一行(append-only)。
    const start = Date.now();
    // 用本轮真实 agent(委派轮 = mochi 等)而非写死 defaultAgentPath:trustTier 求值、
    // requestToolApproval 卡片归属(agent→WS fan-out / owner)、executeTool 执行 context 都按它走。
    // 写死成 'forge' 会让被委派 agent 的权限卡错记到主 agent,turn 收尾的
    // denyPermissionsForSession(sid,'forge') 误杀其 pending,用户回答 resolve 不回去 → 卡死。
    const agentPath = agentId?.trim() || defaultAgentPath;
    const session = _getSessionManager().peek(sid) ?? (await _getSessionManager().open(sid));
    // 新 Session 以 tree 为 runtime 身份权威;旧的最小 host 协作方只有 scheduler。
    // 无 tree 时只降级身份解析,后面的 trust gate 仍然照常执行,不能从兼容分支直达工具。
    const hasRuntimeTree = typeof session.tree?.resolve === 'function';
    const runtimeInstance = hasRuntimeTree ? session.tree.resolve(agentPath) : undefined;
    if (runtimeInstance) {
      await session.initializeAgentHost(agentPath);
    }
    const agent = hasRuntimeTree
      ? session.getAgentHost(agentPath)
      : typeof session.getAgentHost === 'function'
        ? session.getAgentHost(agentPath)
        : session.scheduler?.getAgent?.(agentPath);
    if (!agent || (hasRuntimeTree && !runtimeInstance)) {
      // agent 不在线 —— trustTier 尚未求得,与 sessions.ts 一致记 'unknown' / allow=false。
      appendToolAudit({ ...trace, sid, agent: agentPath, tool: name, trustTier: 'unknown', allow: false, error: `agent '${agentPath}' not live in session`, durationMs: Date.now() - start, ts: start });
      throw new Error(`forgeax-core kernel: agent '${agentPath}' not live in session ${sid}`);
    }

    // Live Runtime identity is templateRef-based. Catalog registration is the
    // single trust authority; a missing entry fails closed to imported.
    let trustTier: 'own' | 'imported' = 'imported';
    if (runtimeInstance) {
      trustTier = resolveTemplateTrust(
        session.templateCatalog,
        runtimeInstance.templateRef,
      );
    } else {
      // Compatibility for minimal/fake sessions that predate RuntimeInstance.
      // This is only an identity fallback; _checkKernelTool below remains mandatory.
      try {
        trustTier = (await _loadAgentRecord(agentPath, { projectRoot: defaultProjectRoot() })).trustTier;
      } catch {
        /* fail-closed → imported */
      }
    }
    if (!isBuiltinToolEnabled(name)) {
      const error = `builtin tool not enabled: ${name}`;
      appendToolAudit({ ...trace, sid, agent: agentPath, tool: name, trustTier, allow: false, error, durationMs: Date.now() - start, ts: start });
      throw new Error(error);
    }
    // R2-08:imported 写禁但「该 session 绑定的 game 目录内」豁免。永久绑定(PR2)下豁免基准
    // 是 session 自己绑的 game(config.defaultDir 由路径派生),非全局 active game——绑 A、
    // active 切 B 时不会误判 A 自己的写。session 未绑则回落 active game。
    const projectRoot = defaultProjectRoot();
    const scopeGame = session.config?.defaultDir ?? getPathManager().resolveScope();
    // sid 供 ui_invoke 的 per-action catalog projection 查询(见 trust-gate)。
    const decision = _checkKernelTool(trustTier, name, {
      args, projectRoot, activeGame: scopeGame, sid,
      rules: loadSettingsPermissionRules(projectRoot),
      ...agentToolPermissions(session, runtimeInstance, projectRoot),
    });
    tt('htb.decision', { name, agent: agentPath, sid, trustTier, outcome: decision.outcome, cap: decision.capability });
    if (decision.outcome === 'deny') {
      // 信任闸硬拒 —— 审计记录 allow=false。
      appendToolAudit({ ...trace, sid, agent: agentPath, tool: name, trustTier, allow: false, error: decision.reason ?? `denied by trust tier: ${name}`, durationMs: Date.now() - start, ts: start });
      throw new Error(decision.reason ?? `denied by trust tier: ${name}`);
    }
    // ask:弹权限卡阻塞等用户(命中本会话 remember 直放);拒绝/超时 → 抛(fail-closed)。
    // The registry keeps hidden kit entries for hot reload. Re-project the
    // canonical agent_manage visibility at this second execution boundary so
    // a direct native host-tool call cannot bypass kits.disable.
    const visibleAgentManagementTools = new Set(
      visibleAgentManagementToolsForAgent(sid, agentPath),
    );
    const visible = filterVisibleAgentManagementTools(
      visibleTools(
        withAgentHostToolDefinitions(agent.agentContext.tools.list(), agent.agentContext),
        agent.agentContext,
      ),
      visibleAgentManagementTools,
    );
    const toolScope = await executionToolScope(
      runtimeInstance?.template, visible.map((tool) => tool.name), projectRoot, scopeGame,
    );
    if (!toolScope.allows(requestedToolName)) {
      const error = `tool not granted to agent: ${requestedToolName}`;
      appendToolAudit({ ...trace, sid, agent: agentPath, tool: requestedToolName, trustTier, allow: false, error, durationMs: Date.now() - start, ts: start });
      throw new Error(error);
    }
    const delegateConfirmation =
      decision.outcome === 'ask' &&
      !isForgeaxBuiltinTool(name) &&
      !getHostTool(name)?.run &&
      _shouldDelegateHostToolConfirmation(name, visible);
    if (decision.outcome === 'ask' && !delegateConfirmation) {
      tt('htb.approval-wait', { name, agent: agentPath, sid, cap: decision.capability });
      const approved = await _requestToolApproval({
        eventBus: session.eventBus,
        sid,
        agent: agentPath,
        toolName: name,
        ...(decision.capability ? { capability: decision.capability } : {}),
        args,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      tt('htb.approval-result', { name, agent: agentPath, approved });
      if (!approved) {
        // 用户拒绝 —— 审计记录 allow=false。
        appendToolAudit({ ...trace, sid, agent: agentPath, tool: name, trustTier, allow: false, error: 'denied by user', durationMs: Date.now() - start, ts: start });
        throw new Error(`denied by user: ${name}`);
      }
    }

    tt('htb.exec-start', { name, agent: agentPath });
    try {
      // 执行解析顺序:①内置 forgeax 工具(remember/memory_search/ui_*/echo)走宿主侧
      //   实现;②产品壳 seam 注入且带 run 的 host 工具(list_games/query_world/
      //   capture_frame,P1-7)走 `HostToolSpec.run`;③其余查 agent 的 kit 注册表。
      //   schema 都由 compose-turn-request 出墙。
      const seamTool = getHostTool(name);
      const configuredProjectMcp = isProjectMcpToolName(name, projectRoot);
      const builtinCtx = {
        projectRoot,
        agentId: agentPath,
        ...(scopeGame ? { game: scopeGame } : {}),
        ...(callId?.trim() ? { callId: callId.trim() } : {}),
        ...(turnCallId?.trim() ? { turnCallId: turnCallId.trim() } : {}),
        eventBus: session.eventBus,
        sid,
      };
      let kitExecuted = false;
      const runKit = () => {
        kitExecuted = true;
        return _executeTool(
          name,
          (args ?? {}) as Record<string, unknown>,
          visible,
          agent.agentContext,
        );
      };
      const canonicalAgentTool = visibleAgentManagementTools.has(name as AgentManagementToolName)
        ? canonicalAgentManagementTool(name as AgentManagementToolName)
        : undefined;
      const out = isForgeaxBuiltinTool(name)
        ? await runForgeaxBuiltinTool(name, (args ?? {}) as Record<string, unknown>, builtinCtx)
        : canonicalAgentTool
          ? await executeTool(
              name,
              (args ?? {}) as Record<string, unknown>,
              [canonicalAgentTool],
              agent.agentContext,
            )
        : seamTool?.run
          ? await seamTool.run((args ?? {}) as Record<string, unknown>, hostToolRunCtx(builtinCtx))
          : name.startsWith('skill_')
            ? await runSkillKernelTool(name, args, {
                kind: 'ai',
                sessionId: sid,
                agentId: agentPath,
              })
            : name.startsWith('mcp__')
              ? await (async () => {
                  const projectResult = await projectMcp.callIfKnown(name, args);
                  if (configuredProjectMcp && projectResult === undefined) {
                    throw new ProjectMcpToolNotFoundError(name);
                  }
                  return projectResult === undefined ? await runKit() : projectResult;
                })()
              : await runKit();
      // 工具返回 `{error}` 形状 = 失败(与 `:sid/kernel-tool` 同口径:Unknown tool / 校验失败 /
      //   工具内 throw 都落此形状)。翻成 throw → 下方 catch 记**唯一**一行 ok:false 审计 +
      //   rethrow → RPC reject → 内核标 isError(而非 ok:true 夹 error,§5 fail-fast)。
      if (out && typeof out === 'object' && !Array.isArray(out) && 'error' in out) {
        const rawErr = (out as { error: unknown }).error;
        const errMsg = typeof rawErr === 'string' ? rawErr
          : rawErr instanceof Error ? rawErr.message
          : JSON.stringify(rawErr);
        throw new Error(errMsg);
      }
      tt('htb.exec-done', { name, agent: agentPath, ms: Date.now() - start });
      // 工具执行成功 —— allow=true / ok=true。
      appendToolAudit({ ...trace, sid, agent: agentPath, tool: name, trustTier, allow: true, ok: true, durationMs: Date.now() - start, ts: start });
      if (kitExecuted) {
        recordSessionHostToolWrites(session, {
          result: out,
          agentPath,
          ...(callId?.trim() ? { toolCallId: callId.trim() } : {}),
          ...(scopeGame ? { gameSlug: scopeGame } : {}),
        });
      }
      return out;
    } catch (e) {
      tt('htb.exec-error', { name, agent: agentPath, ms: Date.now() - start, err: (e as Error).message });
      // 工具执行抛出 —— allow=true / ok=false,审计后照旧 rethrow。
      appendToolAudit({ ...trace, sid, agent: agentPath, tool: name, trustTier, allow: true, ok: false, error: (e as Error).message, durationMs: Date.now() - start, ts: start });
      throw e;
    }
  };
}
