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
import type { AgentKernel, TurnRequest, TurnMessage } from '@forgeax/agent-runtime';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getSessionManager } from '../core/session-registry';
import { getPathManager } from '../fs/path-manager';
import { materializeFileAttachments } from './materialize-file-attachments';
import { orchestrationProfileOf } from './kernel-profile';
import { ContextWindow } from '../context-window/context-window';
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
  /** Stable identities of inbound messages already persisted for this turn.
   *  Excluded from host-owned history because they are also `input.text`. */
  historyExcludeEvents?: readonly EventIdentity[];
  /** UI npc_text(npc_text);npc_text agent.json npc_text */
  model?: string;
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
  const record = await loadAgentRecord(input.agentId, { projectRoot, game: scopeSlug });
  const stableMem = composeStableMemory(record.memory);
  const persona = [record.persona, stableMem].filter((s) => s && s.trim()).join('\n\n---\n\n');
  // dynamicSuffix(npc_text bust npc_text)= npc_text episodes npc_text,npc_text(npc_text)npc_text
  // npc_text:npc_text episodes=0,episodic npc_text npc_text1npc_text
  const episodic = composeEpisodicRecall(record.memory);
  const rebirth = composeReincarnationNotice(record.memory);
  if (rebirth && scopeSlug) {
    emitLifeEvent({ kind: 'rebirth.projected', agentId: input.agentId, into: scopeSlug, at: Date.now() });
  }
  // 运行期错误感知回灌(M8):上一轮后游戏运行期 console/preview error 排空进本轮 user 后缀,
  // 让 agent 看见自己写的代码在引擎里真实报的错(轮间注入,不进 system prompt)。
  const notes = drainPerceptionNotes(input.sessionId);
  const runtimeFeedback = notes.length
    ? `# Runtime feedback from the game preview (console npc_text newest last)\n${notes
        .map((n) => `- [${n.level}] ${n.text}`)
        .join('\n')}\n\nIf these indicate a problem with code you wrote, fix it; otherwise acknowledge and continue.`
    : '';
  const replyLang = input.replyLanguage ? replyLanguageDirective(input.replyLanguage) : '';
  const dynamicSuffix = [rebirth, episodic, runtimeFeedback, replyLang].filter((s) => s && s.trim()).join('\n\n---\n\n');

  // npc_text + npc_text:UI npc_text(input.model)npc_text;npc_text agent.json::models.model
  // npc_text = [npc_text, ...fallback](--fallback-model npc_text),npc_text = npc_text
  const resolvedModels = input.model ? { model: input.model } : await resolveAgentModels(input.sessionId, input.agentId);
  const model = resolvedModels.model;
  const fallbackModels = resolvedModels.fallbackModels;

  // npc_text(npc_text,npc_text)npc_text npc_text MCP npc_text
  // npc_text:FORGEAX_TOOLS(npc_text)> seam hostTools(npc_text,npc_text list_games/
  //   query_world/capture_frame)> first-class UI action(catalog npc_text)> extraTools
  //   (agent host-tools/kits)> record.tools(soul-pack tools/*.json)> skill-derivednpc_text
  //   npc_text/host npc_text,soul-pack npc_text
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
  // R2/C1:npc_text soul-packnpc_text tools(npc_text ToolSpec[])npc_text
  pushDeduped(record.tools ?? []);
  // skills(SkillRefLite,npc_text ToolSpec)npc_text npc_text invocation ToolSpec,npc_text +
  //   agent npc_textkind/description npc_text description;npc_text `args` npc_text,
  //   npc_text skill schema npc_text SkillRunner npc_text(follow-up)npc_text
  pushDeduped(skillsToToolSpecs(record.skills ?? []));

  // P3(B npc_text):npc_text `delivery`npc_textown npc_text core npc_text builtin npc_text
  //   npc_text 'local'(forgeax-core npc_text,npc_text NodeSandboxFs,npc_text+crash npc_text);npc_text
  //   (bash/npc_text/npc_text/npc_text)npc_texthost npc_text(list_games/query_worldnpc_text)npc_textimported npc_text 'host'(npc_text,
  //   npc_text host-tool-bridgenpc_textcheckKernelTool npc_text)npc_textclaude-code/codex npc_text
  //   fail-closed:trustTier npc_text 'own' npc_text allowlist npc_text 'host'npc_text
  const deliveredTools = tools.map((t) => ({
    ...t,
    delivery: (record.trustTier === 'own' && t.name != null && LOCAL_CAPABLE_TOOLS.has(t.name)
      ? 'local'
      : 'host') as 'local' | 'host',
  }));

  const profile = orchestrationProfileOf(input.kernel);
  // Host-owned history is a kernel-owned capability, not an environment/kernel-id guess.
  const history = profile.hostOwnedHistory
    ? await materializeNativeHistory(
        input.sessionId,
        input.agentId,
        input.historyExcludeEvents,
      )
    : undefined;

  // Every attachment is materialized. Native kinds remain path-only references; unsupported
  // kinds become path notes. This keeps base64 off the sidecar wire and durable history.
  let uploadBase = projectRoot;
  try {
    if (input.sessionId) uploadBase = getPathManager().session(input.sessionId).root();
  } catch { /* layout npc_text npc_text npc_text projectRoot */ }
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
    ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
    // pack npc_text manifest.json npc_text(maxTurns/maxBudgetUsd npc_text --max-turns/--max-budget-usd)npc_text
    budget: record.budget ?? {},
    // npc_text(npc_text)npc_text npc_text npc_text**npc_text**npc_text auto-memory(npc_text/npc_text/npc_textSSOT)npc_text
    // npc_text fork-extract npc_text;forgeax-core npc_text=no-op,rented(cc)npc_text
    memoryAutonomy: false,
    trustTier: record.trustTier,
    ...(input.sessionId ? { hostSessionId: input.sessionId } : {}),
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    ...(model ? { model } : {}),
    ...(fallbackModels && fallbackModels.length ? { fallbackModels } : {}),
    ...(history && history.length ? { history } : {}),
  };
}

/** Materialize host-owned history for a kernel whose profile requests it. */
async function materializeNativeHistory(
  sessionId: string | undefined,
  agentId: string,
  excludeEvents?: readonly EventIdentity[],
): Promise<TurnMessage[] | undefined> {
  if (!sessionId) return undefined;
  try {
    const session = getSessionManager().peek(sessionId);
    if (!session) return undefined;
    // The in-memory ledger map is only a cache. After a session refresh/open it
    // can be empty even though the per-agent WAL is present on disk. Always
    // hydrate the exact requested agent key; falling back to `forge` crosses
    // conversation ownership boundaries and makes custom roles lose history.
    const ledger = session.getOrCreateLedger(agentId);
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
    const cw = new ContextWindow(agentId, historyLedger, session.blackboard);
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
