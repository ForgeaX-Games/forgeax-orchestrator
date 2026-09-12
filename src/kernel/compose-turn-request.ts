/**
 * composeTurnRequest — 编排层把一次 chat 组装成中立 `TurnRequest`(喂内核)。
 *
 * M2:**编排层真正拥有"组装一轮"**——systemPrompt(charter + persona)在此拼装,
 * 内核只执行。charter/environment/note 来自注入的产品壳 composer(阶段A §3.2),编排层
 * 自身不含游戏宪章内容,故业务无关。
 *   - charter:产品壳宪章 + 当前激活 scope note(稳定缓存前缀)
 *   - persona:marketplace agent 的人格(default/root 无)
 *   - model:优先 body.model,否则读 agent.json::models.model(ModelPicker 不回归)
 *   - tools:M2 仍空(CC 自带工具);MCP 工具下发在 M3。
 */
import { createAgentToolScope } from '../agents/tool-grants';
import type {
  AgentKernel,
  PreparedHistory as RuntimePreparedHistory,
  TurnContextSnapshot,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getSessionManager } from '../core/session-registry';
import { getPathManager } from '../fs/path-manager';
import { materializeFileAttachments } from './materialize-file-attachments';
import { hasNativeHistoryResume, restoreNativeHistory, orchestrationProfileOf } from './kernel-profile';
import {
  materializeTurnContext,
  type EventIdentity,
} from '../runtime/turn-context';
import {
  getEnabledBuiltinTools,
  getSystemPromptComposer,
  getHostTools,
} from '../orchestration-seams';
import {
  composeEpisodicRecall,
  composeReincarnationNotice,
  emitLifeEvent,
} from '../soul';
import { drainPerceptionNotes } from '../api/lib/perception-registry';
import { firstClassUiToolSpecs } from '../api/lib/ui-manifest-registry';
import type { FrozenAgentTemplate } from '../agents/template-types';
import type { AgentInstance } from '../runtime/types';
import { getConfiguredModelContextWindows } from '../llm/provider';
import { resolveTemplateTrust } from '../agents/agent-template-catalog';
import { pinAgentPermissions } from './agent-permissions';
import { resolveAgentComposition } from '../agents/resolved-agent-composition';
import type { SystemBlock } from '../llm/types';
import type { LedgerReader } from '../context-window/context-window';
import type { BlackboardAPI } from '../core/types';
import { HistoryCoordinator } from '../history/coordinator';
import { LedgerHistorySource, LedgerLaneStore } from '../history/ledger-history';
import { renderHistoryPatch } from '../history/text-bridge';
import { getExtensionSnapshot } from '../extensions/registry';
import { projectToolSpecs } from '../capabilities/projection';
import { skillToolSpecs, safeSkillToolId } from '../skills/tool-specs';
import {
  canonicalAgentManagementToolName,
  type AgentManagementToolName,
} from '../kits/agent-management-visibility';
import { capToolsForProvider, pinnedHostToolWireNames } from './tool-budget';
import { discoverProjectMcpTools, projectMcpExecutionMode } from './project-mcp';
import { isValidSummonAgentId, summonAgentDirective } from './summon-agent';
import {
  FORGEAX_BUILTIN_TOOL_NAMES,
  FORGEAX_TOOLS,
} from './builtin-tool-roster';
import { isBuiltinToolEnabled } from './builtin-tool-policy';

/** P3(B 路径):core 有 builtin 实现的「安全类」工具集。own trustTier 下这些标
 *  `delivery:'local'`(forgeax-core 内核本进程直跑)。name 与 core builtin 对齐,且
 *  @forgeax/orchestrator `builtin/kits/workspace/tools/` 同名。危险类(bash/出网/删/凭据)与 host
 *  专属工具(list_games/query_world…)不入此集 → 仍走 host 桥把闸。 */
// File mutations intentionally stay host-delivered. The host AgentFs recorder
// is the SSOT for causal file activity and Artifact cards; executing write/edit
// inside a kernel bypasses that recorder and can produce a false `no_change`
// settle. Read-only tools and todo_write remain safe to run local.
const LOCAL_CAPABLE_TOOLS = new Set<string>(['read_file', 'grep', 'glob', 'todo_write']);

export type { EventIdentity } from '../runtime/turn-context';
/** Every builtin in FORGEAX_TOOLS is opt-in: it is advertised only when the
 *  embedder names it in the `enabledBuiltinTools` seam. Default off keeps the
 *  reusable orchestration layer free of product-specific capabilities (task
 *  flow / digital-life memory / UI bridge / sub-agent delegation / ask_user),
 *  so a standalone or other-product consumer of the tgz never inherits them.
 *  The same policy is enforced at the host execution boundaries, so a tool
 *  never advertised is not reachable through a direct bridge call either.
 *  Derived from FORGEAX_TOOLS itself so embedders and tests
 *  can never drift from the real roster (§2 Derive). */
export { FORGEAX_BUILTIN_TOOL_NAMES };

export interface ComposeInput {
  message: string;
  agentId: string;
  /** Already-resolved target kernel; compose derives history/attachment policy from its profile. */
  kernel: AgentKernel;
  /** Runtime-selected context. Compatibility callers may omit it and use the
   *  Session lookup fallback during migration. */
  context?: TurnContextSnapshot;
  /** Explicit host-owned history source for callers outside a live Session. */
  historyLedger?: LedgerReader;
  historyBlackboard?: BlackboardAPI;
  /** Capability-only composition used by native prewarm; it must not mutate or
   * expose turn history. */
  prewarm?: boolean;
  turnId?: string;
  threadId?: string;
  sessionId?: string;
  callId?: string;
  /** Stable identities of inbound messages already persisted for this turn.
   *  Excluded from host-owned history because they are also `input.text`. */
  historyExcludeEvents?: readonly EventIdentity[];
  /** Retry-only escape hatch used after a process-local native history owner
   *  disappears between composition and admission. */
  forceSnapshot?: boolean;
  /** UI 直传的模型覆盖(优先);否则从 agent.json 解析。 */
  model?: string;
  /** 该 agent 的 host-tools(kits/toolRegistry)→ 经 MCP 桥下发内核(T-A)。 */
  extraTools?: TurnRequest['tools'];
  /** Agent-level visibility already resolved by the authoritative caller's
   * kits/host-tool surface. An empty array is authoritative and hides every
   * agent_manage builtin; omitted preserves direct-call compatibility. */
  visibleAgentManagementTools?: readonly AgentManagementToolName[];
  /** RuntimeAgentHost 在当前 execution revision 上解析的 Kit prompt slots。 */
  kitSystemBlocks?: readonly SystemBlock[];
  /** 多模态附件。形状开放(contract `InputMessage.attachments`):
   *  `{ kind:'image'|'document', mediaType, data?(base64) | path?(host 文件) }` 透传进
   *  `TurnRequest.input.attachments`,由原生内核 facade 组 image/document block;
   *  `{ kind:'file', name, mediaType, data }` 在本层落盘 uploads/ 换成路径注记
   *  (见 materializeFileAttachments),对全部内核生效。 */
  attachments?: TurnRequest['input']['attachments'];
  /** 全链路 trace:上游(浏览器 ui.request)的 W3C traceparent;透传进 TurnRequest,
   *  内核 facade 把 kernel.turn 挂成它的 child。缺省 ⇒ kernel.turn 自建 root。 */
  traceparent?: string;
  /** 本轮期望的回复语言(UI 结算:跟随输入 / 快捷开关)。注入进 `dynamicSuffix`
   *  (轮间 user 后缀,不进 persona/charter,不 bust 缓存前缀),让 agent 用该语言
   *  回复。缺省 ⇒ 不注入(agent 自行判断)。 */
  replyLanguage?: 'en' | 'zh';
}

/** 一行回复语言指令(英文中立,注入 dynamicSuffix)。 */
function replyLanguageDirective(lang: 'en' | 'zh'): string {
  const name = lang === 'zh' ? 'Simplified Chinese' : 'English';
  return `# Reply language\nWrite your reply to the user in ${name}. Keep code, identifiers, file paths and technical terms unchanged.`;
}

export async function composeTurnRequest(input: ComposeInput): Promise<TurnRequest> {
  const projectRoot = defaultProjectRoot();
  const profile = orchestrationProfileOf(input.kernel);
  const runtimeInstance = resolveRuntimeInstance(input.sessionId, input.agentId);
  const runtimeTemplate = runtimeInstance?.template;
  const permissionSession = input.sessionId ? getSessionManager().peek(input.sessionId) : undefined;
  const permissions = runtimeInstance && permissionSession
    ? pinAgentPermissions(permissionSession, runtimeInstance, projectRoot, input.kernel.id)
    : undefined;
  // charter / environment / note 由注入的产品壳 composer 提供(阶段A §3.2)——编排层不再
  // 硬编码游戏宪章。无注入(standalone game-agnostic cli)⇒ composer 缺省 ⇒ 三段皆空。
  const scopeSlug = sessionScopeSlug(input.sessionId ?? input.threadId) ?? getPathManager().resolveScope();
  const charter = composeHostSystemPrompt(projectRoot, scopeSlug);

  // The frozen template is the only live Runtime base. A real native soul-pack
  // may overlay it; a soul miss never falls through to extension synthesis.
  // Callers outside RuntimeTree receive one exclusive legacy composition.
  const composition = await resolveAgentComposition({
    agentId: runtimeTemplate?.definition.id ?? input.agentId,
    projectRoot,
    ...(scopeSlug ? { game: scopeSlug } : {}),
    ...(runtimeTemplate ? { template: runtimeTemplate } : {}),
    ...(runtimeInstance ? { runtimeConfig: runtimeInstance.runtimeConfig.current().value } : {}),
    ...(input.kitSystemBlocks ? { kitSystemBlocks: input.kitSystemBlocks } : {}),
  });
  const runtimeTrust = resolveRuntimeTrust(input.sessionId, runtimeTemplate);
  const trustTier = runtimeTrust ?? composition.trustFallback;
  // dynamicSuffix(不 bust 缓存)= 今世 episodes 召回,或(有前世首进新世界)转世唤醒。
  // 两者互斥:转世通知要求今世 episodes=0,episodic 召回要求 ≥1。
  const episodic = composeEpisodicRecall(composition.memory);
  const rebirth = composeReincarnationNotice(composition.memory);
  if (rebirth && scopeSlug) {
    emitLifeEvent({ kind: 'rebirth.projected', agentId: input.agentId, into: scopeSlug, at: Date.now() });
  }
  // 运行期错误感知回灌(M8):上一轮后游戏运行期 console/preview error 排空进本轮 user 后缀,
  // 让 agent 看见自己写的代码在引擎里真实报的错(轮间注入,不进 system prompt)。
  const notes = drainPerceptionNotes(input.sessionId);
  const runtimeFeedback = notes.length
    ? `# Runtime feedback from the game preview (console — newest last)\n${notes
        .map((n) => `- [${n.level}] ${n.text}`)
        .join('\n')}\n\nIf these indicate a problem with code you wrote, fix it; otherwise acknowledge and continue.`
    : '';
  const replyLang = input.replyLanguage ? replyLanguageDirective(input.replyLanguage) : '';
  let dynamicSuffix = [
    rebirth,
    episodic,
    composition.dynamicPrompt,
    runtimeFeedback,
    replyLang,
  ].filter((s) => s && s.trim()).join('\n\n---\n\n');

  // 模型 + 级联回退:UI 覆盖(input.model)是所选内核的模型。否则 agent.json
  // 的模型只属于 ForgeaX Core；租用内核使用其本地 CLI 当前选择的模型。
  const resolvedModels = input.model ? { model: input.model } : await resolveAgentModels(input.sessionId, input.agentId);
  const model = input.model ?? (input.kernel.id === 'forgeax-core' ? resolvedModels.model : undefined);
  const fallbackModels = input.model ? undefined : (input.kernel.id === 'forgeax-core' ? resolvedModels.fallbackModels : undefined);
  const modelContextWindows = getConfiguredModelContextWindows();

  // 合并工具(去重,名字冲突时先到先得)→ 经 MCP 桥下发内核。
  // 优先级:FORGEAX_TOOLS(内置真值)> seam hostTools(产品壳注入,如 list_games/
  //   query_world/capture_frame)> first-class UI action(catalog 派生)> extraTools
  //   (agent host-tools/kits)> resolved template/soul composition tools。
  //   内置/host 工具在冲突时获胜,soul-pack 不能覆盖宿主真值工具。
  // All builtins are opt-in: advertised only when the embedder enabled them via
  // the seam; default off keeps the shared layer product-agnostic.
  const toolScope = createAgentToolScope(runtimeTemplate?.configuration?.toolGrants, [
    ...(input.extraTools ?? []).map((tool) => tool.name),
    ...composition.tools.map((tool) => tool.name),
    ...(runtimeTemplate?.execution.skills ?? [])
      .filter((skill) => (skill.executor ?? 'prompt') !== 'prompt')
      .map((skill) => safeSkillToolId(skill.id)),
  ]);
  const enabledBuiltins = getEnabledBuiltinTools();
  const builtinNames = new Set(FORGEAX_BUILTIN_TOOL_NAMES);
  const visibleAgentManagementTools = input.visibleAgentManagementTools === undefined
    ? undefined
    : new Set(input.visibleAgentManagementTools);
  const isAdvertisedBuiltin = (name: string): boolean => {
    const agentManagementTool = canonicalAgentManagementToolName(name);
    if (!isBuiltinToolEnabled(name, enabledBuiltins)) return false;
    if (
      agentManagementTool
      && visibleAgentManagementTools !== undefined
      && !visibleAgentManagementTools.has(agentManagementTool)
    ) return false;
    const isBuiltin = builtinNames.has(name);
    const isUiAlias = name.startsWith('ui_act_');
    if (!isBuiltin && !isUiAlias) return true;
    if (!enabledBuiltins.has(isUiAlias ? 'ui_invoke' : name)) return false;
    // ui_act_* is a first-class alias derived from ui_invoke. Keep the alias
    // namespace behind the same product gate even when a second source passes
    // an alias directly as extraTools.
    return true;
  };
  const activeForgeaxTools = FORGEAX_TOOLS.filter((t) => toolScope.allows(t.name) && isAdvertisedBuiltin(t.name));
  const seen = new Set(activeForgeaxTools.map((t) => t.name));
  const tools: TurnRequest['tools'] = [...activeForgeaxTools];
  type ToolEntry = NonNullable<TurnRequest['tools']>[number];
  const pushDeduped = (cands: ReadonlyArray<{ name?: string }>) => {
    for (const t of cands) {
      if (t?.name && toolScope.allows(t.name) && isAdvertisedBuiltin(t.name) && !seen.has(t.name)) {
        seen.add(t.name);
        tools.push(t as ToolEntry);
      }
    }
  };
  // seam hostTools:只出墙可序列化三元组(run 是宿主侧执行体,永不过 wire)。
  pushDeduped(getHostTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
  // P1-9 一等工具化:server catalog 里标 firstClass 的 UI action 派生独立 ToolSpec
  //   (ui_act_*)。模型原生看到 schema、免一次 snapshot 发现往返;执行/权限在两个
  //   host 工具执行口被反解回 ui_invoke(actionId)走同一 per-action 闸与往返。
  //   ui_act_* are per-action shortcuts of ui_invoke, so they ride the same
  //   opt-in seam — with the UI bridge builtin off they must not leak.
  if (enabledBuiltins.has('ui_invoke')) pushDeduped(firstClassUiToolSpecs(input.sessionId));
  pushDeduped(input.extraTools ?? []);
  const projectMcpMode = projectMcpExecutionMode(input.kernel.id, trustTier);
  if (toolScope.hasProjectMcpGrants) {
    pushDeduped(await discoverProjectMcpTools(projectRoot, { retainPool: projectMcpMode === 'host' }));
  }
  pushDeduped(composition.tools);
  const residentPromptSkillIds = runtimeTemplate
    ? new Set(
        runtimeTemplate.execution.skills
          .filter((skill) => (skill.executor ?? 'prompt') === 'prompt')
          .map((skill) => skill.id),
      )
    : undefined;
  pushDeduped(skillToolSpecs(residentPromptSkillIds, input.sessionId));

  // P3(B 路径):给每个工具标 `delivery`——own 的「安全类且 core 有 builtin 实现」的工具
  //   标 'local'(forgeax-core 内核本进程直跑,经 NodeSandboxFs,满速+crash 隔离);危险类
  //   (bash/出网/删/凭据)、host 专属(list_games/query_world…)、imported 一律 'host'(缺省,
  //   回宿主走 host-tool-bridge→checkKernelTool 把闸)。claude-code/codex 等租用内核忽略此字段。
  //   fail-closed:trustTier 非 'own' 或不在 allowlist → 'host'。
  const deliveredBeforeProjection = tools.map((t) => ({
    ...t,
    delivery: (trustTier === 'own' && t.name != null && LOCAL_CAPABLE_TOOLS.has(t.name)
      ? 'local'
      : 'host') as 'local' | 'host',
  }));
  const capabilitySnapshot = getExtensionSnapshot().capabilities;
  const projectedTools = capabilitySnapshot
    ? projectToolSpecs(
        deliveredBeforeProjection,
        capabilitySnapshot,
        profile.nativeAttachmentKinds.length > 0 ? 'native' : 'rented',
      )
    : deliveredBeforeProjection;
  const deliveredTools = capToolsForProvider(projectedTools, {
    pinNames: [
      ...activeForgeaxTools.map((tool) => tool.name),
      ...pinnedHostToolWireNames(),
    ],
  });

  // Open the durable ledger before materializing context, including after a
  // host restart when the agent has not yet been loaded in this process.
  const sharedLedger = input.sessionId && !input.prewarm
    ? getSessionManager().peek(input.sessionId)?.getOrCreateLedger(input.agentId)
    : undefined;

  // Context data is host-selected and offered to every kernel. Whether a
  // stateful CLI resumes, replays or reconciles it is an internal kernel choice.
  const context = input.prewarm
    ? undefined
    : input.context ?? (input.historyLedger
      ? await materializeTurnContext({
          agentId: input.agentId,
          ledger: input.historyLedger,
          ...(input.historyBlackboard ? { blackboard: input.historyBlackboard } : {}),
          excludeEvents: input.historyExcludeEvents,
        })
      : await materializeSessionContext(
          input.sessionId,
          input.agentId,
          input.historyExcludeEvents,
        ));
  const history = context ? [...context.messages] : undefined;

  // Every attachment is materialized. Native kinds remain path-only references; unsupported
  // kinds become path notes. This keeps base64 off the sidecar wire and durable history.
  let uploadBase = projectRoot;
  try {
    if (input.sessionId) uploadBase = getPathManager().session(input.sessionId).root();
  } catch { /* layout 未就绪 → 落 projectRoot */ }
  const uploads = materializeFileAttachments(
    input.attachments,
    resolvePath(uploadBase, 'uploads'),
    profile.nativeAttachmentKinds,
  );
  // Native EventBus ingress may already have appended the durable path note.
  // Re-materialization is idempotent; avoid duplicating model-visible context.
  const retainedPaths = (uploads.attachments ?? [])
    .map((att) => att.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  const noteAlreadyPresent = retainedPaths.length > 0
    && retainedPaths.every((path) => input.message.includes(path));
  const messageText = uploads.note && !noteAlreadyPresent
    ? `${input.message}\n\n${uploads.note}`
    : input.message;

  const request: TurnRequest = {
    session: { threadId: input.threadId ?? '', agentId: input.agentId },
    ...(input.turnId ? { turnId: input.turnId } : {}),
    callId: input.callId,
    input: {
      text: messageText,
      ...(uploads.attachments && uploads.attachments.length ? { attachments: uploads.attachments } : {}),
    },
    // pack 经 manifest.json 声明的策略(promptMode/toolPolicy)透传给内核 profile。
    // own/builtin(forge)无 manifest ⇒ 缺省 append + 无 toolPolicy(零回归)。
    systemPrompt: {
      charter,
      persona: composition.persona,
      ...(dynamicSuffix ? { dynamicSuffix } : {}),
      ...(composition.promptMode ? { mode: composition.promptMode } : {}),
    },
    tools: deliveredTools,
    ...(capabilitySnapshot ? { capabilityGeneration: capabilitySnapshot.generation } : {}),
    ...(composition.toolPolicy ? { toolPolicy: composition.toolPolicy } : {}),
    // Resident iteration limits and native soul budget overrides share one composition.
    budget: composition.budget ?? {},
    // 编排层(数字生命引擎)拥有记忆成长 → 内核**不得自主**跑 auto-memory(防双写/双成本/两套SSOT)。
    // 内核的 fork-extract 机制仍可被编排层驱动;forgeax-core 本无自主记忆=no-op,rented(cc)据此关闭其自带提取。
    memoryAutonomy: false,
    trustTier,
    ...(permissions ? { permissionMode: permissions.permissionMode } : {}),
    ...(input.sessionId ? { hostSessionId: input.sessionId } : {}),
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    ...(model ? { model } : {}),
    ...(fallbackModels && fallbackModels.length ? { fallbackModels } : {}),
    ...(modelContextWindows ? { modelContextWindows } : {}),
    ...(context ? { context } : {}),
    ...(history && history.length ? { history } : {}),
  };
  if (input.sessionId && !input.prewarm && !input.forceSnapshot && profile.historyIntake !== 'structured') {
    await restoreNativeHistory(input.kernel, request);
  }
  let preparedHistory: RuntimePreparedHistory | undefined;
  // Shared history is prepared by one coordinator for both native and rented kernels.
  if (input.sessionId && !input.prewarm) {
    try {
      const ledger = sharedLedger;
      if (ledger) {
        const coordinator = new HistoryCoordinator(new LedgerHistorySource(ledger), new LedgerLaneStore(ledger));
        const result = await coordinator.prepare({
          kernelId: input.kernel.id,
          intake: profile.historyIntake,
          // A rented CLI may only receive the post-cursor gap after its own
          // adapter has established a resumable private chat for this thread.
          // A new process/server restart has no such proof and therefore gets
          // one authoritative snapshot instead of silently losing context.
          nativeResumeAvailable: profile.historyIntake === 'structured'
            || hasNativeHistoryResume(input.kernel, input.threadId),
          ...(input.forceSnapshot ? { forceSnapshot: true } : {}),
        });
        if ('code' in result) throw new Error(`${result.code}: ${result.message}`);
        // A resident is materialized before its first user turn; binding an
        // empty lane at that bootstrap boundary creates history-control
        // events before the resident's registration ledger is otherwise
        // visible. Legacy callers still need the empty initial lane so their
        // first transcribed turn can establish the shared-history cursor.
        if (result.messages.length > 0 || !runtimeTemplate) {
          await new LedgerLaneStore(ledger).put(result.lane);
          ledger.append({
            type: 'kernel_history_dispatching', ts: Date.now(), source: 'history-coordinator',
            payload: {
              laneId: result.lane.laneId, kernelId: input.kernel.id, epoch: result.lane.epoch,
              mode: result.mode, ...(result.from ? { from: result.from } : {}),
              ...(result.through ? { patchThrough: result.through } : {}), patchId: result.patchId,
            },
          } as never);
        }
        preparedHistory = {
          mode: result.mode,
          messages: result.messages,
          patchId: result.patchId,
          laneId: result.lane.laneId,
          epoch: result.lane.epoch,
          ...(result.through ? { through: result.through } : {}),
          estimatedTokens: result.estimatedTokens,
          redactedParts: result.redactedParts,
        };
        if (profile.historyIntake === 'text-bridge') {
          const patch = renderHistoryPatch(result.messages, result.patchId);
          if (patch) dynamicSuffix = [dynamicSuffix, patch].filter(Boolean).join('\n\n---\n\n');
        }
      }
    } catch (error) {
      // Do not silently execute a rented kernel without the history it was meant to receive.
      if (input.sessionId && input.kernel.id !== 'forgeax-core') throw error;
    }
  }

  return {
    ...request,
    systemPrompt: { ...request.systemPrompt, ...(dynamicSuffix ? { dynamicSuffix } : {}) },
    ...(preparedHistory ? { historyPlan: preparedHistory } : {}),
  };
}

/** Compose the product-shell-owned stable host prompt for Turn and inspect.
 *
 * Keeping this helper pure prevents Observatory from reconstructing a second
 * approximation of the bytes sent by the Runtime turn. */
export function composeHostSystemPrompt(
  projectRoot: string,
  scopeSlug?: string,
): string {
  const composer = getSystemPromptComposer();
  const note = composer?.activeGameNote(scopeSlug) ?? '';
  let environment = '';
  try {
    environment = composer?.environment({
      cwd: projectRoot,
      projectRoot,
      slug: scopeSlug ?? null,
    }) ?? '';
  } catch {
    environment = '';
  }
  return [composer?.charter() ?? '', environment, note]
    .filter((section) => section && section.trim())
    .join('\n\n');
}

/** Compatibility fallback for callers not yet holding an instance EventStore. */
async function materializeSessionContext(
  sessionId: string | undefined,
  agentId: string,
  excludeEvents?: readonly EventIdentity[],
): Promise<TurnContextSnapshot | undefined> {
  if (!sessionId) return undefined;
  try {
    const session = getSessionManager().peek(sessionId);
    const ledger = session?.ledgers.get(agentId) ?? session?.ledgers.get('forge');
    if (!session || !ledger) return undefined;
    return await materializeTurnContext({
      agentId,
      ledger,
      blackboard: session.blackboard,
      excludeEvents,
    });
  } catch {
    return undefined;
  }
}

/** 当前 chat tab 绑定的游戏 slug(peek-only,不 hydrate);'default'/不存在 → undefined。 */
function sessionScopeSlug(sid?: string): string | undefined {
  if (!sid) return undefined;
  try {
    const slug = getSessionManager().peek(sid)?.config.defaultDir;
    if (!slug || slug === 'default') return undefined;
    // existence guard via PathManager (path-segments, no `.forgeax/games` literal).
    return existsSync(getPathManager().user().gameDir(slug)) ? slug : undefined;
  } catch {
    return undefined;
  }
}

/** best-effort 读 `<sid>/agents/<agentId>/agent.json::models.model`。
 *  数组形态 = [主模型, ...fallback]:首个有效串作 model,其余作 fallbackModels(--fallback-model)。
 *  单串 = 仅主模型、无回退。读不到 → 空。 */
async function resolveAgentModels(
  sessionId?: string,
  agentId?: string,
): Promise<{ model?: string; fallbackModels?: string[] }> {
  if (!sessionId || !agentId) return {};
  try {
    const pm = getPathManager();
    const path = pm.session(sessionId).agent(agentId).agentJson();
    const cfg = JSON.parse(await readFile(path, 'utf8')) as { models?: { model?: string | string[] | null } };
    return normalizeModelChain(cfg.models?.model);
  } catch {
    return {};
  }
}

function normalizeModelChain(
  raw: string | string[] | null | undefined,
): { model?: string; fallbackModels?: string[] } {
  if (Array.isArray(raw)) {
    const clean = raw
      .filter((value): value is string =>
        typeof value === 'string' && value.trim().length > 0
      )
      .map((value) => value.trim());
    if (!clean.length) return {};
    return {
      model: clean[0],
      ...(clean.length > 1 ? { fallbackModels: clean.slice(1) } : {}),
    };
  }
  return typeof raw === 'string' && raw.trim()
    ? { model: raw.trim() }
    : {};
}

function resolveRuntimeInstance(
  sessionId: string | undefined,
  agentId: string,
): AgentInstance | undefined {
  if (!sessionId) return undefined;
  return getSessionManager().peek(sessionId)?.tree.resolve(agentId);
}

function resolveRuntimeTrust(
  sessionId: string | undefined,
  template: FrozenAgentTemplate | undefined,
): 'own' | 'imported' | undefined {
  if (!sessionId || !template) return undefined;
  const session = getSessionManager().peek(sessionId);
  if (!session) return undefined;
  return resolveTemplateTrust(session.templateCatalog, template.templateRef);
}
