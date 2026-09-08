/** session-create —— 「建 session + bootstrap 入口 agent」的单一实现(SSOT)。
 *
 *  两个消费者:①`POST /api/sessions` 路由(api/sessions.ts);②UI 语义操作层的
 *  headless handler(kernel/ui-headless-actions.ts 的 `session.create`,UI 不在线时
 *  ui_invoke 回落执行)。抽到独立模块(而非留在 sessions.ts)是为了避免
 *  sessions.ts → forgeax-builtin-tools → ui-headless-actions → sessions.ts 的环。
 *  逻辑从路由原样搬入(方案 §5 硬约束:headless 路径必须调与 UI 相同的实现)。
 */
import { getSessionManager } from '../../core/session-manager';
import { getPathManager } from '../../fs/path-manager';
import type { AgentJson, ModelsConfig } from '../../core/types';
import { ensureAgentScaffold, isValidAgentName } from '../../core/agent-scaffold';
import { resolveExternalAgentTemplate } from '../../agents/loader';
import { loadBrand } from '../../brand';

/** 终极 fallback —— Brand pack 缺 / 解析失败时回到泛用 'root' path。
 *  e2e 测试(`makeSidWithRootAgent`)也走这条 path,保持兼容。 */
export const FALLBACK_BOOTSTRAP_AGENT = 'root';

/** 真正的「默认入口 agent」—— active Brand pack 声明的主助手 id。
 *  Brand loader 已 memoize，session 创建不重复解析文件。
 *  失败回 root —— 跟 ref agenteam `cmdChat` 拿不到 agent context 时的兜底
 *  policy 同款(不阻塞 session 创建,让用户后续手动 pin)。 */
export function resolveBrandMainAgent(): string {
  try {
    return loadBrand().config.assistant.agent.id || FALLBACK_BOOTSTRAP_AGENT;
  } catch {
    return FALLBACK_BOOTSTRAP_AGENT;
  }
}

export interface CreateSessionBody {
  displayName?: string;
  defaultModels?: ModelsConfig;
  timezone?: string;
  autoStart?: boolean;
  runtimeEventsRoot?: string;
  scope?: string;
  /** undefined = 解析 manifest 默认 agent;"<name>" 指定;false/''/null = 不 bootstrap。 */
  bootstrapAgent?: string | false | null;
}

/** 建 session(永久绑当前 active game,PR2)+ bootstrap 入口 agent。
 *  与历史 `POST /api/sessions` 路由逐行同义(注释随迁)。 */
export async function createSessionWithBootstrap(
  body: CreateSessionBody,
): Promise<{ sid: string; bootstrappedAgent: string | null }> {
  const sm = getSessionManager();
  let bootstrappedAgent: string | null = null;
  let bootstrapPlan:
    | { readonly agentPath: string; readonly overrides: Partial<AgentJson> }
    | null = null;

  if (
    body.bootstrapAgent !== false &&
    body.bootstrapAgent !== null &&
    body.bootstrapAgent !== ''
  ) {
    const agentPath = typeof body.bootstrapAgent === 'string'
      ? body.bootstrapAgent
      : resolveBrandMainAgent();
    const overrides: Partial<AgentJson> = {};
    const isSimpleName =
      !agentPath.includes('/') &&
      !agentPath.includes('#') &&
      isValidAgentName(agentPath);
    if (isSimpleName && agentPath !== FALLBACK_BOOTSTRAP_AGENT) {
      try {
        const persona = await resolveExternalAgentTemplate(agentPath);
        if (persona?.personaPath) overrides.personaFile = persona.personaPath;
        if (persona?.memoryDir) overrides.memoryDir = persona.memoryDir;
        if (persona) overrides.skillSources = persona.skillSources;
        if (persona?.tools?.length) {
          overrides.kits = {
            config: { 'host-tools': { allow: persona.tools } },
          };
        }
      } catch (error: any) {
        process.stderr.write(
          `[sessions] bootstrap persona resolve for '${agentPath}' failed: ${
            error?.message ?? error
          }\n`,
        );
      }
    }
    bootstrapPlan = { agentPath, overrides };
  }

  // Permanent binding (plan B PR2): the new session is bound to the current
  // active game by the injected SessionLayout (paths.allocate) — its home
  // becomes <games>/<activeSlug>/sessions/<sid>/. No defaultDir is passed/stored.
  const session = await sm.create({
    displayName: body.displayName,
    defaultModels: body.defaultModels,
    timezone: body.timezone,
    autoStart: body.autoStart,
    runtimeEventsRoot: body.runtimeEventsRoot,
    scope: body.scope,
    ...(bootstrapPlan
      ? {
          prepareResidentDefinitions: async (sid: string) => {
            try {
              await ensureAgentScaffold(sid, bootstrapPlan!.agentPath, {
                ...(Object.keys(bootstrapPlan!.overrides).length
                  ? { overrides: bootstrapPlan!.overrides }
                  : {}),
              });
              bootstrappedAgent = bootstrapPlan!.agentPath;
            } catch (error: any) {
              process.stderr.write(
                `[sessions] bootstrap agent '${bootstrapPlan!.agentPath}' for ${sid} failed: ${
                  error?.message ?? error
                }\n`,
              );
            }
          },
        }
      : {}),
  });

  return { sid: session.sid, bootstrappedAgent };
}

const pendingEnsureByScope = new Map<
  string,
  Promise<{ sid: string; bootstrappedAgent: string | null; created: boolean }>
>();

/** Idempotent session bootstrap for concurrent UI observers. The active
 * layout remains the sole owner of scope-to-path binding. */
export async function ensureSessionWithBootstrap(
  body: CreateSessionBody,
): Promise<{ sid: string; bootstrappedAgent: string | null; created: boolean }> {
  const sm = getSessionManager();
  const scope = body.scope ?? getPathManager().resolveScope();
  const key = scope ?? "__global__";
  const pending = pendingEnsureByScope.get(key);
  if (pending) return pending;
  const existing = sm.list(scope ? { game: scope } : {})[0];
  if (existing) return { sid: existing.sid, bootstrappedAgent: null, created: false };
  const promise = createSessionWithBootstrap({ ...body, scope })
    .then((created) => ({ ...created, created: true }))
    .finally(() => pendingEnsureByScope.delete(key));
  pendingEnsureByScope.set(key, promise);
  return promise;
}
