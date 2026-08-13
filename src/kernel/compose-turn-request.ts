/**
 * composeTurnRequest npc_text npc_text chat npc_text `TurnRequest`(npc_text)npc_text
 *
 * M2:**npc_text"npc_text"**npc_textsystemPrompt(charter + persona)npc_text,
 * npc_textcharter/environment/note npc_text composer(npc_textA npc_text3.2),npc_text
 * npc_text,npc_text
 *   - charter:npc_text + npc_text scope note(npc_text)
 *   - persona:marketplace agent npc_text(default/root npc_text)
 *   - model:npc_text body.model,npc_text agent.json::models.model(ModelPicker npc_text)
 *   - tools:M2 npc_text(CC npc_text);MCP npc_text M3npc_text
 */
import { randomUUID } from 'node:crypto';
import type { AgentKernel, TurnRequest, TurnMessage, PreparedHistory as RuntimePreparedHistory } from '@forgeax/agent-runtime';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getSessionManager } from '../core/session-registry';
import { getPathManager } from '../fs/path-manager';
import { materializeFileAttachments } from './materialize-file-attachments';
import { hasNativeHistoryResume, orchestrationProfileOf } from './kernel-profile';
import { standingModeFor } from './permission-config';
import { ContextWindow, type LedgerReader } from '../context-window/context-window';
import type { BlackboardAPI } from '../core/types';
import { HistoryCoordinator } from '../history/coordinator';
import { LedgerHistorySource, LedgerLaneStore } from '../history/ledger-history';
import { renderHistoryPatch } from '../history/text-bridge';
import { llmMessagesToTurnHistory } from './llm-history';
import { getSystemPromptComposer, getHostTools } from '../orchestration-seams';
import {
  loadAgentRecord,
  composeStableMemory,
  composeEpisodicRecall,
  composeReincarnationNotice,
  emitLifeEvent,
} from '../soul';
import { drainPerceptionNotes } from '../api/lib/perception-registry';
import { firstClassUiToolSpecs } from '../api/lib/ui-manifest-registry';
import { getExtensionSnapshot } from '../extensions/registry';
import { projectToolSpecs } from '../capabilities/projection';
import { skillToolSpecs } from '../skills/tool-specs';
import { discoverProjectMcpTools, projectMcpExecutionMode } from './project-mcp';
import { tt } from '../lib/turn-trace';
import type { SkillRefLite } from '../soul/types';
import uiBridgeContract from './ui-bridge-contract.json';
import { NPC_TOOL_CONTRACTS } from '@forgeax/types/npc-tools';

/** P3(B npc_text):core npc_text builtin npc_textown trustTier npc_text
 *  `delivery:'local'`(forgeax-core npc_text)npc_textname npc_text core builtin npc_text,npc_text
 *  @forgeax/orchestrator `builtin/kits/workspace/tools/` npc_text(bash/npc_text/npc_text/npc_text)npc_text host
 *  npc_text(list_games/query_worldnpc_text)npc_text npc_text npc_text host npc_text */
const LOCAL_CAPABLE_TOOLS = new Set<string>(['read_file', 'write_file', 'edit_file', 'grep', 'glob']);

/** npc_text(npc_text ToolSpec)npc_text MCP server + `--allowedTools` npc_text
 *  `memory_search`/`remember`/`soul_create` = npc_text(R6)npc_text,npc_text = soul npc_text/npc_text soul-packnpc_text
 *  npc_text(list_games/query_world/capture_frame)**npc_text**npc_text
 *  npc_text HostToolSpec seam npc_text(npc_textA npc_text3 npc_text,P1-7 npc_text),cli npc_text */
const FORGEAX_TOOLS = [
  {
    name: 'memory_search',
    description:
      "Search your long-term layered memory (identity / traits / episodes, including past-life worlds) for relevant entries. Returns { query, matches:[{tier, game?, file, text}] }.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'remember',
    description:
      "Persist a durable memory about the user or this game into your long-term layered memory so you recall it in future sessions (npc_text). kind:'general' = portable fact about the user (carries across games); kind:'game' = bound to the current game world.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['general', 'game'] }, title: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'soul_create',
    description: NPC_TOOL_CONTRACTS.soul_create.description,
    inputSchema: NPC_TOOL_CONTRACTS.soul_create.inputSchema,
  },
  {
    name: 'npc_wire',
    description: NPC_TOOL_CONTRACTS.npc_wire.description,
    inputSchema: NPC_TOOL_CONTRACTS.npc_wire.inputSchema,
  },
  // UI npc_text(npc_text AI npc_text P0):ui_snapshot / ui_invokenpc_text SSOT =
  // ui-bridge-contract.json(npc_text .mjs MCP server npc_text npc_text npc_text
  // npc_text)npc_text forgeax-builtin-tools.ts,npc_text trust-gate npc_text per-action npc_text
  ...uiBridgeContract.tools,
];

export interface EventIdentity {
  sgen: string;
  seq: number;
}

export interface ComposeInput {
  message: string;
  agentId: string;
  /** Already-resolved target kernel; compose derives history/attachment policy from its profile. */
  kernel: AgentKernel;
  threadId?: string;
  sessionId?: string;
  callId?: string;
  /** 本次 compose 尝试的唯一 id。调用方生成并**同时**传给转录,让 manifest 与
   *  真正执行的那一轮 hook:turnStart 共享同一个键 —— 否则多条同 turn 的 manifest
   *  依然裁决不了哪条生效(2026-08-06 外审:上一轮只加了 id、没建立链路)。 */
  turnAttemptId?: string;
  /** Stable identities of inbound messages already persisted for this turn.
   *  Excluded from host-owned history because they are also `input.text`. */
  historyExcludeEvents?: readonly EventIdentity[];
  /** Live agent-owned history dependencies. Passing these avoids rediscovering
   *  the same ledger through a process singleton at the package boundary. */
  historyLedger?: LedgerReader;
  historyBlackboard?: BlackboardAPI;
  /** UI 直传的模型覆盖(优先);否则从 agent.json 解析。 */
  model?: string;
  /** Build a capability-complete transport warm-up without mutating history,
   * manifests, perception queues, or life-event state. The returned request
   * still carries the real host session id and exact tool/permission surface,
   * but it is never sent as a model turn. */
  prewarm?: boolean;
  /** npc_text agent npc_text host-tools(kits/toolRegistry)npc_text npc_text MCP npc_text(T-A)npc_text */
  extraTools?: TurnRequest['tools'];
  /** npc_text(contract `InputMessage.attachments`):
   *  `{ kind:'image'|'document', mediaType, data?(base64) | path?(host npc_text) }` npc_text
   *  `TurnRequest.input.attachments`,npc_text facade npc_text image/document block;
   *  `{ kind:'file', name, mediaType, data }` npc_text uploads/ npc_text
   *  (npc_text materializeFileAttachments),npc_text */
  attachments?: TurnRequest['input']['attachments'];
  /** npc_text trace:npc_text(npc_text ui.request)npc_text W3C traceparent;npc_text TurnRequest,
   *  npc_text facade npc_text kernel.turn npc_text childnpc_text npc_text kernel.turn npc_text rootnpc_text */
  traceparent?: string;
  /** npc_text(UI npc_text:npc_text / npc_text)npc_text `dynamicSuffix`
   *  (npc_text user npc_text,npc_text persona/charter,npc_text bust npc_text),npc_text agent npc_text
   *  npc_text npc_text npc_text(agent npc_text)npc_text */
  replyLanguage?: 'en' | 'zh';
}

/** npc_text(npc_text,npc_text dynamicSuffix)npc_text */
function replyLanguageDirective(lang: 'en' | 'zh'): string {
  const name = lang === 'zh' ? 'Simplified Chinese' : 'English';
  return `# Reply language\nWrite your reply to the user in ${name}. Keep code, identifiers, file paths and technical terms unchanged.`;
}

export async function composeTurnRequest(input: ComposeInput): Promise<TurnRequest> {
  const composeStartedAt = Date.now();
  const stage = (name: string, startedAt: number) => {
    tt('compose.stage', { stage: name, ms: Date.now() - startedAt, totalMs: Date.now() - composeStartedAt });
  };
  const projectRoot = defaultProjectRoot();
  // charter / environment / note npc_text composer npc_text(npc_textA npc_text3.2)npc_text
  // npc_text(standalone game-agnostic cli)npc_text composer npc_text npc_text npc_text
  const composer = getSystemPromptComposer();
  const scopeSlug = sessionScopeSlug(input.sessionId ?? input.threadId) ?? getPathManager().resolveScope();
  const note = composer?.activeGameNote(scopeSlug) ?? '';
  // environment(Paths / npc_text / Workbench npc_text / Skills npc_text)npc_textWorking directory =
  //   projectRoot:core npc_text process.cwd()(serve.ts npc_text projectRoot)npc_text,npc_text charter
  //   npc_textstarts at project rootnpc_textbest-effort:composer npc_text/npc_text npc_text npc_text environment,npc_text
  let environment = '';
  try {
    environment = composer?.environment({ cwd: projectRoot, projectRoot, slug: scopeSlug ?? null }) ?? '';
  } catch {
    environment = '';
  }
  const charter = [composer?.charter() ?? '', environment, note].filter((s) => s && s.trim()).join('\n\n');

  // R6 npc_text:npc_text agentIdnpc_text AgentRecord(persona + npc_text + npc_text)npc_text
  //  - persona(stable npc_text)= soul persona + identity/traits + MEMORY.md npc_text
  //  - dynamicSuffix(user npc_text,npc_textbusts cache)= npc_text game npc_text episodes npc_text
  //  - trustTier npc_text = npc_text(pass-through npc_text enforcement)
  let stageStartedAt = Date.now();
  const record = await loadAgentRecord(input.agentId, { projectRoot, game: scopeSlug });
  stage('agent-record', stageStartedAt);
  const stableMem = composeStableMemory(record.memory);
  const persona = [record.persona, stableMem].filter((s) => s && s.trim()).join('\n\n---\n\n');
  // dynamicSuffix(npc_text bust npc_text)= npc_text episodes npc_text,npc_text(npc_text)npc_text
  // npc_text:npc_text episodes=0,episodic npc_text npc_text1npc_text
  const episodic = composeEpisodicRecall(record.memory);
  const rebirth = composeReincarnationNotice(record.memory);
  if (rebirth && scopeSlug && !input.prewarm) {
    emitLifeEvent({ kind: 'rebirth.projected', agentId: input.agentId, into: scopeSlug, at: Date.now() });
  }
  // 运行期错误感知回灌(M8):上一轮后游戏运行期 console/preview error 排空进本轮 user 后缀,
  // 让 agent 看见自己写的代码在引擎里真实报的错(轮间注入,不进 system prompt)。
  const notes = input.prewarm ? [] : drainPerceptionNotes(input.sessionId);
  const runtimeFeedback = notes.length
    ? `# Runtime feedback from the game preview (console npc_text newest last)\n${notes
        .map((n) => `- [${n.level}] ${n.text}`)
        .join('\n')}\n\nIf these indicate a problem with code you wrote, fix it; otherwise acknowledge and continue.`
    : '';
  const replyLang = input.replyLanguage ? replyLanguageDirective(input.replyLanguage) : '';
  let dynamicSuffix = [rebirth, episodic, runtimeFeedback, replyLang].filter((s) => s && s.trim()).join('\n\n---\n\n');
  // 模型 + 级联回退:UI 显式覆盖(input.model)是所选内核的模型。否则 agent.json
  // 的模型只属于 Forgeax Core；不能把 Claude provider 名透传给 Codex/Cursor 等
  // 独立订阅 runtime，否则会在模型 API 前被拒绝。warm 与当前真实 CLI 请求都不
  // 传显式 model，因此两者仍然使用同一个 provider-native pool key。
  stageStartedAt = Date.now();
  const agentModels = input.model ? undefined : await resolveAgentModels(input.sessionId, input.agentId);
  stage('model-resolve', stageStartedAt);
  const model = input.model ?? (input.kernel.id === 'forgeax-core' ? agentModels?.model : undefined);
  const fallbackModels = input.model ? undefined : (input.kernel.id === 'forgeax-core' ? agentModels?.fallbackModels : undefined);

  // 合并工具(去重,名字冲突时先到先得)→ 经 MCP 桥下发内核。
  // 优先级:FORGEAX_TOOLS(内置真值)> seam hostTools(产品壳注入,如 list_games/
  //   query_world/capture_frame)> first-class UI action(catalog 派生)> extraTools
  //   (agent host-tools/kits)> record.tools(soul-pack tools/*.json)> extension skills>
  //   soul-pack skills。
  //   内置/host 工具在冲突时获胜,soul-pack 不能覆盖宿主真值工具。
  const seen = new Set(FORGEAX_TOOLS.map((t) => t.name));
  const tools: TurnRequest['tools'] = [...FORGEAX_TOOLS];
  type ToolEntry = NonNullable<TurnRequest['tools']>[number];
  const pushDeduped = (cands: ReadonlyArray<{ name?: string }>) => {
    for (const t of cands) {
      if (t?.name && !seen.has(t.name)) {
        seen.add(t.name);
        tools.push(t as ToolEntry);
      }
    }
  };
  // seam hostTools:npc_text(run npc_text,npc_text wire)npc_text
  pushDeduped(getHostTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
  // P1-9 npc_text:server catalog npc_text firstClass npc_text UI action npc_text ToolSpec
  //   (ui_act_*)npc_text schemanpc_text snapshot npc_text;npc_text/npc_text
  //   host npc_text ui_invoke(actionId)npc_text per-action npc_text
  pushDeduped(firstClassUiToolSpecs(input.sessionId));
  pushDeduped(input.extraTools ?? []);
  // Project MCP is discovered once at the turn boundary so every kernel gets
  // the same canonical names and schemas. Native providers only need a
  // schema-only discovery; host-routed providers retain the pooled clients
  // for /kernel-tool execution. Keeping this mode decision here prevents a
  // native provider and the host bridge from spawning the same project server.
  stageStartedAt = Date.now();
  const projectMcpMode = projectMcpExecutionMode(input.kernel.id, record.trustTier);
  pushDeduped(await discoverProjectMcpTools(projectRoot, { retainPool: projectMcpMode === 'host' }));
  stage('project-mcp', stageStartedAt);
  // R2/C1:npc_text soul-packnpc_text tools(npc_text ToolSpec[])npc_text
  stageStartedAt = Date.now();
  pushDeduped(record.tools ?? []);
  // Extension skills are runnable through the host bridge. Add only this
  // executable catalog kind: command/MCP/memory entries remain discovery data
  // until each has a concrete runtime dispatcher.
  pushDeduped(skillToolSpecs());
  // skills(SkillRefLite,非 ToolSpec)→ 派生最小 invocation ToolSpec,让内核能放行 +
  //   agent 自知其技能。kind/description 透传到 description;暂用 `args` 自由文本入参,
  //   结构化 skill schema 待 SkillRunner 接线(follow-up)。
  pushDeduped(skillsToToolSpecs(record.skills ?? []));

  // P3(B npc_text):npc_text `delivery`npc_textown npc_text core npc_text builtin npc_text
  //   npc_text 'local'(forgeax-core npc_text,npc_text NodeSandboxFs,npc_text+crash npc_text);npc_text
  //   (bash/npc_text/npc_text/npc_text)npc_texthost npc_text(list_games/query_worldnpc_text)npc_textimported npc_text 'host'(npc_text,
  //   npc_text host-tool-bridgenpc_textcheckKernelTool npc_text)npc_textclaude-code/codex npc_text
  //   fail-closed:trustTier npc_text 'own' npc_text allowlist npc_text 'host'npc_text
  const capabilitySnapshot = getExtensionSnapshot().capabilities;
  const projectedTools = capabilitySnapshot
    ? projectToolSpecs(tools, capabilitySnapshot, 'rented')
    : tools;
  const deliveredTools = projectedTools.map((t) => {
    return {
      ...t,
      delivery: (record.trustTier === 'own' && t.name != null && LOCAL_CAPABLE_TOOLS.has(t.name)
        ? 'local'
        : 'host') as 'local' | 'host',
    };
  });

  // 模型是照着"这一轮它能看见哪些工具"做决策的,而这个工具面是动态组装的
  // (persona 白名单 + 插件在装状态 + catalog 派生的 UI action),事后从 git 复原
  // 不出来 —— 两套账本都没记它。只记名字与投递方式,不序列化 schema(每轮都写会
  // 把账本撑爆)。纯观测:任何失败都吞掉,绝不影响这一轮。
  try {
    if (input.sessionId && !input.prewarm) {
      const session = getSessionManager().peek(input.sessionId);
      if (session) {
        const manifestLedger = session.getOrCreateLedger(input.agentId);
        manifestLedger.append({
          type: 'x.tools.manifest',
          ts: Date.now(),
          source: 'compose-turn-request',
          payload: {
            // 连接键,两把:manifest 在轮**开始**时写、转录在轮**结束**时写,只靠文件
            // 相邻配对的话,重叠轮次 / 被 409 拒发的轮 / 冷启首轮都会把工具面安到错误
            // 的轮上,而且发生时无任何标记可察觉。callId 逐字对上本轮 hook:toolCall,
            // 但它依赖调用方传入(2026-08-06 实测:FORGE 前端不传,真实账本三条 manifest
            // 全空)。turn 不依赖调用方:转录侧在 append user_input **之前**取
            // nextTurnOrdinal(),这里在轮开始时取,两处读到同一计数,与本轮
            // hook:turnStart.payload.turn 同值。被 409 拒发的轮不转录、不涨计数,
            // 只会留下一条同 turn 值的孤儿 manifest —— 可察觉,不误配。
            ...(input.callId ? { callId: input.callId } : {}),
            // turnAttemptId:每次 compose 唯一。turn 是**意向**轮序,可能重号 ——
            // 这一轮若随后被 history_unavailable 拒发(409),user_input 不会增加,
            // 重试就产生第二条同 turn 的 manifest(2026-08-06 外审;我先前注释里
            // 说"可察觉,不误配"是过头了:消费方拿到两条根本裁决不了哪条生效)。
            // 消费方应先按 turnAttemptId 取最后一条,turn 只作分组线索。
            turnAttemptId: input.turnAttemptId ?? randomUUID(),
            turn: manifestLedger.nextTurnOrdinal(),
            turnSemantics: 'intended-ordinal-may-repeat-on-retry',
            count: deliveredTools.length,
            tools: deliveredTools.map(({ name, delivery }) => ({ name, delivery })),
            trustTier: record.trustTier,
          },
        });
      }
    }
  } catch { /* 观测通道绝不影响主流程 */ }
  stage('tool-manifest', stageStartedAt);

  const profile = orchestrationProfileOf(input.kernel);
  let preparedHistory: RuntimePreparedHistory | undefined;
  // Shared history is prepared by one coordinator for both native and rented kernels.
  if (input.sessionId && !input.prewarm) {
    stageStartedAt = Date.now();
    try {
      const session = getSessionManager().peek(input.sessionId);
      const ledger = session?.getOrCreateLedger(input.agentId);
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
        });
        if ('code' in result) throw new Error(`${result.code}: ${result.message}`);
        await new LedgerLaneStore(ledger).put(result.lane);
        ledger.append({
          type: 'kernel_history_dispatching', ts: Date.now(), source: 'history-coordinator',
          payload: {
            laneId: result.lane.laneId, kernelId: input.kernel.id, epoch: result.lane.epoch,
            mode: result.mode, ...(result.from ? { from: result.from } : {}),
            ...(result.through ? { patchThrough: result.through } : {}), patchId: result.patchId,
          },
        } as never);
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
    stage('history', stageStartedAt);
  }

  // Host-owned history is a kernel-owned capability, not an environment/kernel-id guess.
  stageStartedAt = Date.now();
  const history = !input.prewarm && profile.historyIntake === 'structured'
    ? await materializeNativeHistory(
        input.sessionId,
        input.agentId,
        input.historyExcludeEvents,
        input.historyLedger,
        input.historyBlackboard,
      )
    : undefined;
  stage('native-history', stageStartedAt);

  // 该内核的 standing 权限档(设置页写的项目级配置);未配过 → undefined = 走内核默认档。
  const standingMode = standingModeFor(String(input.kernel.id), projectRoot);

  // Every attachment is materialized. Native kinds remain path-only references; unsupported
  // kinds become path notes. This keeps base64 off the sidecar wire and durable history.
  stageStartedAt = Date.now();
  let uploadBase = projectRoot;
  try {
    if (input.sessionId) uploadBase = getPathManager().session(input.sessionId).root();
  } catch { /* layout npc_text npc_text npc_text projectRoot */ }
  const uploads = materializeFileAttachments(
    input.attachments,
    resolvePath(uploadBase, 'uploads'),
    profile.nativeAttachmentKinds,
  );
  stage('attachments', stageStartedAt);
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

  tt('compose.done', { totalMs: Date.now() - composeStartedAt, tools: deliveredTools.length, history: history?.length ?? 0 });
  return {
    session: { threadId: input.threadId ?? '', agentId: input.agentId },
    callId: input.callId,
    input: {
      text: messageText,
      ...(uploads.attachments && uploads.attachments.length ? { attachments: uploads.attachments } : {}),
    },
    // pack npc_text manifest.json npc_text(promptMode/toolPolicy)npc_text profilenpc_text
    // own/builtin(forge)npc_text manifest npc_text npc_text append + npc_text toolPolicy(npc_text)npc_text
    systemPrompt: {
      charter,
      persona,
      ...(dynamicSuffix ? { dynamicSuffix } : {}),
      ...(record.promptMode ? { mode: record.promptMode } : {}),
    },
    tools: deliveredTools,
    ...(capabilitySnapshot ? { capabilityGeneration: capabilitySnapshot.generation } : {}),
    ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
    // pack npc_text manifest.json npc_text(maxTurns/maxBudgetUsd npc_text --max-turns/--max-budget-usd)npc_text
    budget: record.budget ?? {},
    // npc_text(npc_text)npc_text npc_text npc_text**npc_text**npc_text auto-memory(npc_text/npc_text/npc_textSSOT)npc_text
    // npc_text fork-extract npc_text;forgeax-core npc_text=no-op,rented(cc)npc_text
    memoryAutonomy: false,
    trustTier: record.trustTier,
    // 权限姿态:设置页写的 per-kernel standing 档位(项目级 .forgeax/kernel-permissions.json)。
    // 只在用户显式配过时才填 —— 缺省留空,让各内核落自己的默认档(全内核默认 SSOT 在
    // permission-config.ts)。内核因此不需要知道「设置页」存在,只看这一个中立字段。
    ...(standingMode ? { permissionMode: standingMode } : {}),
    ...(input.sessionId ? { hostSessionId: input.sessionId } : {}),
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    ...(model ? { model } : {}),
    ...(fallbackModels && fallbackModels.length ? { fallbackModels } : {}),
    ...(history && history.length ? { history } : {}),
    ...(preparedHistory ? { historyPlan: preparedHistory } : {}),
  };
}

/** Materialize host-owned history for a kernel whose profile requests it. */
async function materializeNativeHistory(
  sessionId: string | undefined,
  agentId: string,
  excludeEvents?: readonly EventIdentity[],
  injectedLedger?: LedgerReader,
  injectedBlackboard?: BlackboardAPI,
): Promise<TurnMessage[] | undefined> {
  if (!sessionId) return undefined;
  try {
    // The live agent already owns the exact ledger and blackboard. Prefer
    // those dependencies: package subpath builds can otherwise hold a
    // different SessionManager registry instance and silently lose history.
    const session = injectedLedger ? undefined : getSessionManager().peek(sessionId);
    if (!session && !injectedLedger) return undefined;
    // The in-memory ledger map is only a cache. After a session refresh/open it
    // can be empty even though the per-agent WAL is present on disk. Always
    // hydrate the exact requested agent key; falling back to `forge` crosses
    // conversation ownership boundaries and makes custom roles lose history.
    const ledger = injectedLedger ?? session?.getOrCreateLedger(agentId);
    if (!ledger) return undefined;
    // Capture the narrowed reader before async closures (TS does not preserve
    // optional-chain narrowing through those closure boundaries).
    const historySource = ledger;
    const eventKey = (identity: EventIdentity) => `${identity.sgen}:${identity.seq}`;
    const excluded = new Set((excludeEvents ?? []).map(eventKey));
    const keep = (event: Awaited<ReturnType<typeof historySource.readAllEvents>>[number]) => {
      if (event.type !== 'inbound_message') return true;
      const sourceEvent = event.payload?.sourceEvent as EventIdentity | undefined;
      return !sourceEvent || !excluded.has(eventKey(sourceEvent));
    };
    const historyLedger = excluded.size === 0
      ? historySource
      : {
          readAllEvents: async () => (await historySource.readAllEvents()).filter(keep),
          readFromTail: async (_isEnough: (events: Awaited<ReturnType<typeof historySource.readAllEvents>>) => boolean) =>
            (await historySource.readAllEvents()).filter(keep),
        };
    const cw = new ContextWindow(agentId, historyLedger, injectedBlackboard ?? session?.blackboard);
    const msgs = await cw.buildPrompt();
    return llmMessagesToTurnHistory(msgs);
  } catch {
    return undefined; // npc_text fallback:npc_text history npc_text npc_text
  }
}

/** npc_text soul-pack npc_text skills(SkillRefLite,npc_text ToolSpec)npc_text invocation ToolSpecnpc_text
 *  npc_text npc_text npc_text `skill_<skillId>` npc_text,npc_text + agent npc_text skill
 *  schema(npc_text/npc_text)npc_text SkillRunner npc_text,npc_text `args` npc_text(follow-up)npc_text */
function skillsToToolSpecs(skills: ReadonlyArray<SkillRefLite>): TurnRequest['tools'] {
  const sanitize = (id: string) => id.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return skills
    .filter((s) => s && typeof s.skillId === 'string' && s.skillId.trim())
    .map((s) => ({
      name: `skill_${sanitize(s.skillId)}`,
      description: s.description?.trim() || `Invoke the "${s.skillId}" skill (${s.kind}).`,
      inputSchema: { type: 'object', properties: { args: { type: 'string' } } },
    }));
}

/** npc_text chat tab npc_text slug(peek-only,npc_text hydrate);'default'/npc_text npc_text undefinednpc_text */
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

/** best-effort npc_text `<sid>/agents/<agentId>/agent.json::models.model`npc_text
 *  npc_text = [npc_text, ...fallback]:npc_text model,npc_text fallbackModels(--fallback-model)npc_text
 *  npc_text = npc_text npc_text npc_text */
async function resolveAgentModels(
  sessionId?: string,
  agentId?: string,
): Promise<{ model?: string; fallbackModels?: string[] }> {
  if (!sessionId || !agentId) return {};
  try {
    const pm = getPathManager();
    const path = pm.session(sessionId).agent(agentId).agentJson();
    const cfg = JSON.parse(await readFile(path, 'utf8')) as { models?: { model?: string | string[] | null } };
    const raw = cfg.models?.model;
    if (Array.isArray(raw)) {
      const clean = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
      if (!clean.length) return {};
      return { model: clean[0], ...(clean.length > 1 ? { fallbackModels: clean.slice(1) } : {}) };
    }
    return typeof raw === 'string' && raw.trim() ? { model: raw.trim() } : {};
  } catch {
    return {};
  }
}
