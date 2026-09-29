// @forgeax/orchestrator — app seam (Stage0 scaffold).
//
// Reusable orchestration layer entry. The product shell (e.g. packages/server)
// injects product-specific context (resource/data roots, ports, brand) and the
// orchestration layer wires up the Hono router + boot sequence.
//
// 现状(2026-06):`createForgeaxApp(ctx)` boot 编排核心(path / session manager /
// cli-providers / plugins / brand)并挂载全部 /api/* 路由。产品壳 packages/server/
// src/main.ts **已走这条 (a) 路径**:build ctx -> createForgeaxApp(ctx) -> Bun.serve,
// 自己只负责 Bun.serve + 静态 SPA + engine/interface 进程 spawn + vite 代理。

import type { HeadersInit } from 'bun';
import { Hono } from 'hono';
import { join } from 'node:path';
import type { AgentKernel } from '@forgeax/agent-runtime';
import { createHonoExtensionRouter } from '@forgeax/extension-host/http/hono';
import {
  configureExtensionAgentTools,
  type ExtensionAgentHost,
} from './extension-host/agent-tools';

import { createFilesRouter } from '@forgeax/platform-io';
import { createFsBrowserRouter } from '@forgeax/platform-io';
import { createSettingsRouter } from './api/settings';
import { createMemorySettingsRouter } from './api/memory-settings';
import { createKernelPermissionsRouter } from './api/kernel-permissions';
import { createBootSplashRouter } from '@forgeax/platform-io';
import { createVersionRouter } from '@forgeax/platform-io';
import { createChangelogRouter } from '@forgeax/platform-io';
import { createSessionsRouter } from './api/sessions';
import { createLogsRouter } from '@forgeax/platform-io';
import { createCommandsApiRouter } from './api/commands';
import { createCliRouter } from './api/cli/chat';
import { createBrandRouter, loadBrand } from './brand';
import { createBusRouter } from './api/bus';
import { createExtensionsRouter } from './api/extensions';
import { reloadExtensions, onExtensionsReloaded } from './extensions/registry';
import { syncEventTriggerBindings } from './skills/event-bridge';
import { createThreadsRouter } from './api/threads';
import {
  createLlmTestRouter,
  type LlmTestRequestSource,
} from './api/llm-test';
import { createNpcRouter } from './api/npc';
import { NpcRuntime } from './npc-brain/runtime';
import type { NpcMemoryRuntimeBinding } from './npc-brain/memory-host-seam';
import type { ProductNpcAgentRecordResolver } from './npc-brain/service';
import { createUsageRouter } from './api/usage';
import { createToolsRouter } from './api/tools';
import { createEventsRouter } from './api/events';
import { createSkillsRouter } from './api/skills';
import { createPacksRouter } from './api/packs';
import { createRuntimeRouter } from './api/runtime';
import { createObservatoryRouter } from './api/observatory';
import { createHistoryRouter } from './api/history';
import { createGameAssetsRouter } from '@forgeax/platform-io';
import { createGameHostRouter } from '@forgeax/platform-io';
import { createPrefsRouter } from '@forgeax/platform-io';
import { sessionScope } from './api/lib/session-scope';
import { bootCliProviders } from './cli-providers';
import { initPathManager } from './fs/path-manager';
import { installEventJournal } from './events/journal-sink';
import type { SessionLayout } from './fs/session-layout';
import {
  initOrchestrationSeams,
  type SystemPromptComposer,
  type SessionSkillRootProvider,
  type ResidentResourcePolicy,
  type HostToolSpec,
  type HostUiActionHandler,
  type AssetPathPolicy,
  type DeliveryEnricher,
  type ArtifactResolver,
  type UploadDefaults,
  type ProgressPolicyProvider,
} from './orchestration-seams';
import { ensureUserDirDefaults } from './defaults/scaffold';
import { initSessionManager } from './core/session-manager';
import { createRoundDeliveryEnricher } from './checkpoint/round-delivery';
import {
  buildActionCatalog,
  type ActionCatalogEntry,
} from './kernel/action-catalog';
import { listBuiltinHeadlessUiActionIds } from './kernel/ui-headless-actions';
import './llm/register-all';

// Part of the public seam contract (like ProductContext): the product shell
// annotates the upload defaults it injects.
export type { UploadDefaults, ResidentResourcePolicy } from './orchestration-seams';

/** Product-specific context injected by the shell into the orchestration layer. */
export interface ProductContext {
  /** Where orchestrator read-only resources live. Its `builtin/` child contains
   *  runtime-discovered kits and commands. Omitted in source checkouts, where
   *  PathManager derives the package-local builtin directory. */
  resourceRoot?: string;
  /** Private runtime instance root (.forgeax/). User projects are games. */
  instanceRoot: string;
  /** Server-only partial resolver for product-owned NPC AgentRecords. */
  npcSoulResolver?: ProductNpcAgentRecordResolver;
  /** Port assignments for the product processes. */
  ports?: {
    server?: number;
    engine?: number;
    interface?: number;
  };
  /** Studio-wide version string. */
  version?: string;
  /** Optional brand id override. */
  brand?: string;
  /** How session state trees land + how sessions are enumerated, as a **factory**
   *  keyed by instance root. Injected by the product shell (studio = game-nested
   *  `.forgeax/games/<slug>/sessions/<sid>`). A factory (not a single instance) so
   *  the runtime instance is selected at boot — re-initing the PathManager with
   *  only a root would otherwise drop the
   *  layout back to the flat default and hide game-nested sessions. Omitted ⇒
   *  generic flat layout (`<userRoot>/sessions/<sid>`), i.e. @forgeax/orchestrator runs
   *  game-agnostic as a standalone CLI. */
  sessionLayoutFactory?: (instanceRoot: string) => SessionLayout;
  /** Movable runtime-state root (cache / checkpoints / SM debug.log), as a
   *  **factory** keyed by instance root — same shape and reason as
   *  `sessionLayoutFactory`: each runtime instance must build it at boot; a
   *  boot-time string remains tied to that instance
   *  project. (The SessionManager debug.log stream still binds its path at
   *  boot — it re-points on process restart, not on switch.) Omitted ⇒ state
   *  stays under the user root (`~/.forgeax`), i.e. standalone-CLI behavior.
   *  Keys / kits / settings never follow this root. */
  stateRootFactory?: (instanceRoot: string) => string;
  /** Already-started NPC memory binding. The product shell owns provider/
   * outbox lifecycle; HTTP and WS share the single NpcRuntime created here.
   * Omitted preserves the exact legacy/off path. */
  npcMemory?: NpcMemoryRuntimeBinding;
  /** Optional per-decision budget for provider memory recall. */
  npcMemoryRecallBudgetMs?: number;
  /** Business routers injected by the shell, mounted after the static cli routers
   *  (order/path unchanged for the static set). Replaces the per-feature static
   *  mounts as business migrates out of cli (Stage A §3). Each entry mounts at
   *  its `path`; `needsAssetPolicy` marks asset-serving routers that REQUIRE
   *  `assetPathPolicy` (boot throws if missing — §3.4 fail-fast). */
  routers?: Array<{ path: string; router: Hono; needsAssetPolicy?: boolean }>;
  /** System-prompt charter composer (charter + environment + note, fixed order,
   *  typed stable/dynamic split for prompt-cache). Omitted ⇒ cli uses its
   *  generic built-in prompt. (Stage A §3.2) */
  systemPromptComposer?: SystemPromptComposer;
  /** Host-owned session skill directory; no directory semantics in orchestration. */
  sessionSkillRootProvider?: SessionSkillRootProvider;
  /** Optional resource snapshots; the host owns eligibility and legacy paths. */
  residentResourcePolicy?: ResidentResourcePolicy;
  /** Host-only tool specs (list_games / query_world / capture_frame …) exposed
   *  to agents and gated by the host-tool bridge. (Stage A §3, §2.4) */
  hostTools?: HostToolSpec[];
  /** Opt-in builtin tools this product enables. Builtins that are opt-in
   *  (compose-turn-request's OPT_IN_BUILTIN_TOOLS, e.g. `todo_write`) are
   *  advertised only when named here; default off keeps the orchestration layer
   *  generic for other consumers. */
  enabledBuiltinTools?: readonly string[];
  /** Optional orchestrator-owned delivery derivation. The seam stays narrow so
   *  the product shell does not need to know checkpoint/ledger internals. */
  delivery?: DeliveryEnricher;
  /** Host-owned final-turn artifact resolver. Defaults to the checkpoint
   * deriver used by Studio when omitted. */
  artifactResolver?: ArtifactResolver;
  /** UI 语义操作层的 headless 等价 handler(surface:'both'|'server' 的 action,UI
   *  不在线时 ui_invoke 回落到这里执行;server 是行为 SSOT,方案 §5)。 */
  hostUiActions?: HostUiActionHandler[];
  /** Complete trusted host catalog. Omitted: generic role/session lifecycle only.
   * Client manifests can bind executors but cannot add declarations. */
  actionCatalog?: readonly ActionCatalogEntry[];
  /** Explicit host migration debt for declared headless actions lacking handlers.
   * Omitted: no exceptions. Never infer IDs from product names or prior hosts. */
  headlessActionCompatibilityIds?: readonly string[];
  /** Asset path policy replacing the `.forgeax/games` whitelist. Default CLOSED;
   *  the shell opens roots explicitly. Conditionally required + fail-fast when
   *  asset routers are injected (§3.4). */
  assetPathPolicy?: AssetPathPolicy;
  /** Upload destination defaults — the shared repo + shared write token are
   *  product policy/credential, owned by the shell and injected here (the token
   *  used to be a compiled constant in the base's upload/config.ts). Omitted ⇒
   *  upload is unconfigured unless the operator sets `FORGEAX_UPLOAD_*`. */
  uploadDefaults?: UploadDefaults;
  /** Optional product-owned phase/budget/no-progress policy. No injection means
   *  the generic session keeps its existing unconstrained behavior. */
  progressPolicyProvider?: ProgressPolicyProvider;
  /** Optional game-host version-prepare hook (product shell injects platform-specific
   *  behavior, e.g. video-game syncing its component set into the game dir before
   *  a version is committed). game-host stays generic; app only passes it through. */
  gameHostBeforeVersion?: (args: { slug: string; gameDir: string; project: unknown }) => void | Promise<void>;
  gameHostSeedProvider?: (args: { slug: string }) => Promise<{
    project?: unknown;
    blueprint: unknown;
    assetsManifest: unknown;
  }>;
  /** One product-owned Extension Host; orchestrator only mounts its shared HTTP projection. */
  extensionHost?: Parameters<typeof createHonoExtensionRouter>[0] & ExtensionAgentHost;
  /**
   * Host-owned provenance for Model Lab requests. The shell derives this from
   * trusted routing context so game code cannot opt itself into `studio-ui` by
   * forging browser-controlled headers. Omitted for standalone UI-only hosts.
   */
  resolveLlmTestRequestSource?: (request: Request) => LlmTestRequestSource;
  /** Product-owned kernel registry view used by capability APIs. The shell
   * registers product-specific kernels (for example forgeax-core), while the
   * orchestrator still supplies its built-in kernels as a fallback. */
  kernelProvider?: () => readonly AgentKernel[];
}

export interface ForgeaxApp {
  /** The mounted Hono application (caller wires it into Bun.serve). */
  app: Hono;
  /** Play-time NPC runtime shared by HTTP and the shell-owned WS upgrade path. */
  npcRuntime: import('./npc-brain/runtime').NpcRuntime;
}

export function mountExtensionHost(
  app: Hono,
  host: Parameters<typeof createHonoExtensionRouter>[0],
): void {
  const byId = new Hono();
  byId.all('/by-id/:slug/*', async (c) => {
    const maxBodyBytes = 1_048_576;
    const declaredBodyBytes = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declaredBodyBytes) && declaredBodyBytes > maxBodyBytes) {
      return c.json({ error: 'request body is too large' }, 413);
    }
    const gameId = c.req.query('gameId');
    if (!gameId) return c.json({ error: 'gameId is required' }, 400);

    const slug = c.req.param('slug');
    const catalog = await host.catalog(gameId);
    const matches = Array.isArray(catalog)
      ? catalog.filter((candidate): candidate is {
          extensionId: string;
          runtimeId: string;
        } => {
          if (!candidate || typeof candidate !== 'object') return false;
          const entry = candidate as Record<string, unknown>;
          return typeof entry.extensionId === 'string'
            && typeof entry.runtimeId === 'string'
            && entry.extensionId.replace(/^@[^/]+\//, '') === slug;
        })
      : [];
    if (matches.length === 0) {
      return c.json({ error: `extension not found: ${slug}` }, 404);
    }
    if (matches.length !== 1) {
      return c.json({ error: `extension slug is ambiguous: ${slug}` }, 409);
    }

    const url = new URL(c.req.url);
    const pathParts = url.pathname.split('/');
    const byIdIndex = pathParts.indexOf('by-id');
    const extensionPath = url.pathname
      .split('/')
      .slice(byIdIndex + 2)
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
      .join('/');
    const query: Record<string, string[]> = {};
    for (const [key, value] of url.searchParams) {
      if (key !== 'gameId') (query[key] ??= []).push(value);
    }
    const headers: Record<string, string[]> = {};
    for (const [key, value] of c.req.raw.headers) headers[key] = [value];
    const body = c.req.method === 'GET' || c.req.method === 'HEAD'
      ? new Uint8Array()
      : new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxBodyBytes) {
      return c.json({ error: 'request body is too large' }, 413);
    }
    const response = await host.extension({
      gameId,
      runtimeId: matches[0]!.runtimeId,
      path: extensionPath,
      query,
      method: c.req.method,
      headers,
      body,
    });
    return new Response(
      c.req.method === 'HEAD' || response.body === undefined
        ? null
        : Uint8Array.from(response.body),
      {
        status: response.status,
        headers: response.headers as ResponseInit["headers"],
      },
    );
  });
  app.route('/api/extension-runtime', byId);
  app.route('/__extension__/v1', byId);
  app.route(
    '/__extension__/v1',
    createHonoExtensionRouter(host, { prefix: '/__extension__/v1' }),
  );
}

/**
 * Boot the orchestration core and mount every /api/* router onto a fresh Hono
 * app. The caller (product shell) owns Bun.serve, the WS handler, static SPA
 * serving, and engine/interface process spawning + vite proxying.
 *
 * Stage0: minimal seam. Boot side-effects (path manager, session manager,
 * cli-providers, plugins) run here; product-specific plumbing stays in the
 * shell. Stage1-B will fold the remaining boot/serve glue from main.ts in.
 */
export async function createForgeaxApp(ctx: ProductContext): Promise<ForgeaxApp> {
  const { instanceRoot } = ctx;
  const delivery = ctx.delivery ?? createRoundDeliveryEnricher();
  const artifactResolver = ctx.artifactResolver ?? (delivery as unknown as ArtifactResolver);

  buildActionCatalog(ctx.actionCatalog, {
    builtinHeadlessHandlerActionIds: listBuiltinHeadlessUiActionIds(),
    headlessHandlerActionIds: (ctx.hostUiActions ?? []).map((handler) => handler.actionId),
    grandfatheredHeadlessActionIds: ctx.headlessActionCompatibilityIds ?? [],
  });

  try {
    loadBrand();
  } catch {
    /* non-fatal at boot; settings UI can fix brand */
  }

  const pm = initPathManager({
    projectRoot: instanceRoot,
    builtinRoot: ctx.resourceRoot ? join(ctx.resourceRoot, 'builtin') : undefined,
    stateRoot: ctx.stateRootFactory?.(instanceRoot),
    layout: ctx.sessionLayoutFactory?.(instanceRoot),
  });
  // 把 topic 总线的事件落盘。人点界面与 AI 派发走同一条 topic、只用 source 区分,
  // 而总线本身只有 2048 槽内存环 —— 不接这一根线,人这一侧的操作历史留不下来。
  // 总线早就留好了 setJournalSink 插槽,只是生产代码从没调用过。
  installEventJournal({ projectRoot: instanceRoot });
  // Install shell-injected orchestration seams once at boot (same idiom as the
  // path/session managers above). Read-only on the hot path thereafter.
  initOrchestrationSeams({
    residentResourcePolicy: ctx.residentResourcePolicy,
    sessionSkillRootProvider: ctx.sessionSkillRootProvider,
    systemPromptComposer: ctx.systemPromptComposer,
    hostTools: ctx.hostTools,
    delivery,
    artifactResolver,
    hostUiActions: ctx.hostUiActions,
    assetPathPolicy: ctx.assetPathPolicy,
    enabledBuiltinTools: ctx.enabledBuiltinTools,
    uploadDefaults: ctx.uploadDefaults,
    progressPolicyProvider: ctx.progressPolicyProvider,
  });
  if (ctx.extensionHost) {
    await configureExtensionAgentTools(ctx.extensionHost);
  }
  await ensureUserDirDefaults(pm);
  const sm = initSessionManager(pm);

  // 组合根接线:把 skill 事件触发的 rewire 接到 plugins reload 后置钩子。
  // (registry 不直接 import event-bridge —— 断开 plugins→event-bridge→runner→plugins 环)
  onExtensionsReloaded(syncEventTriggerBindings);
  await reloadExtensions();
  await bootCliProviders();
  // Resident templates freeze extension resources and tool grants during
  // restore. Load both registries before any restored resident can run.
  await sm.bootAutoStart();

  const app = new Hono();
  if (ctx.extensionHost) mountExtensionHost(app, ctx.extensionHost);
  const npcRuntime = new NpcRuntime({
    projectRoot: instanceRoot,
    memory: ctx.npcMemory,
    memoryRecallBudgetMs: ctx.npcMemoryRecallBudgetMs,
  });
  if (ctx.npcSoulResolver) {
    npcRuntime.brain.setProductAgentRecordResolver(ctx.npcSoulResolver);
  }

  // 给每个 /api/* 请求建立 ALS session 作用域(从 query/path/JSON body 解析 sid),
  // 让 handler(含 streamSSE 流体)里的 console.* 经 logger bridge 落对应 session
  // 的 <sid>/logs/debug.log —— turn-trace 等诊断日志据此持久化到正确位置。
  app.use('/api/*', sessionScope());

  app.route('/api/files', createFilesRouter());
  app.route('/api/games', createGameAssetsRouter());
  // Per-game package persistence + git versioning (game-host). Reuses the
  // platform-io safe-path whitelist (.forgeax/games/<slug>). The optional
  // version-prepare hook is injected by the product shell (§ ProductContext).
  app.route('/api/game-host', createGameHostRouter({
    beforeVersion: ctx.gameHostBeforeVersion,
    seedProvider: ctx.gameHostSeedProvider,
  }));
  app.route('/api/fs', createFsBrowserRouter());
  app.route('/api/settings', createSettingsRouter());
  app.route('/api/memory-settings', createMemorySettingsRouter());
  app.route('/api/kernel-permissions', createKernelPermissionsRouter(ctx.kernelProvider));
  app.route('/api/boot-splash', createBootSplashRouter());
  app.route('/api/version', createVersionRouter());
  app.route('/api/changelog', createChangelogRouter());
  app.route('/api/sessions', createSessionsRouter());
  app.route('/api/logs', createLogsRouter(instanceRoot));
  app.route('/api/prefs', createPrefsRouter(instanceRoot));
  app.route('/api/commands', createCommandsApiRouter());
  app.route('/api/cli', createCliRouter());
  app.route('/api/brand', createBrandRouter());
  app.route('/api/bus', createBusRouter());
  app.route('/api/extensions', createExtensionsRouter());
  app.route('/api/threads', createThreadsRouter());
  app.route('/api/llm', createLlmTestRouter({
    resolveRequestSource: ctx.resolveLlmTestRequestSource,
  }));
  app.route('/api/npc', createNpcRouter({ projectRoot: instanceRoot, runtime: npcRuntime }));
  app.route('/api/usage', createUsageRouter());
  app.route('/api/tools', createToolsRouter());
  app.route('/api/events', createEventsRouter());
  app.route('/api/skills', createSkillsRouter());
  app.route('/api/packs', createPacksRouter());
  app.route('/api/runtime', createRuntimeRouter());
  app.route('/api/observatory', createObservatoryRouter());
  app.route('/api/history', createHistoryRouter());

  // Shell-injected business routers (mounted after the static cli set). As
  // business migrates out of cli (§3) the static mounts above shrink and these
  // grow — the product's overall route table stays identical. §3.4 fail-fast:
  // an asset-serving router that forgot its policy must crash boot, not run open.
  for (const r of ctx.routers ?? []) {
    if (r.needsAssetPolicy && !ctx.assetPathPolicy) {
      throw new Error(
        `createForgeaxApp: injected router "${r.path}" needs assetPathPolicy but none was provided ` +
          `(asset path whitelist must be explicit — refusing to boot open). See Stage A §3.4.`,
      );
    }
    app.route(r.path, r.router);
  }

  return { app, npcRuntime };
}
