/** Instance-aware ask_user pending registry.
 *
 * UI replies should carry instanceId/runtimeEpochId. The agent address remains
 * a compatibility projection only; a stale epoch reply may never resolve a
 * newly-created resident instance after Session reload.
 */

import { randomUUID } from "node:crypto";
import { tt } from "../lib/turn-trace";

export interface AskOwner {
  /** Host-generated identity for independently pending tool requests. */
  readonly requestId?: string;
  readonly sid: string;
  readonly agentPath: string;
  readonly instanceId: string;
  readonly runtimeEpochId: string;
}

export interface AskReplyItem {
  readonly questionId: string;
  readonly values: string[];
}

export type AskReply = AskReplyItem[];
export type AskResult = AskReply | string[];

export interface AskReplyIdentity {
  readonly requestId?: string;
  readonly instanceId?: string;
  readonly runtimeEpochId?: string;
}

export type ExternalAskReplyResolver = (
  sid: string,
  agentPath: string,
  values: AskReply | string[],
  identity: AskReplyIdentity,
) => boolean | Promise<boolean>;

interface Pending extends AskOwner {
  readonly requestId: string;
  readonly resolve: (values: AskResult | null) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

// The packaged desktop server currently reaches the orchestrator through both
// the package root (`dist/index.js`) and the curated kernel subpath. Depending
// on the bundler, those entry points can materialize two module instances in
// one process. A module-local Map then makes an ask registered by the host-tool
// bridge invisible to the HTTP `/ask-reply` route. Keep the registry on the
// process global symbol registry so source/dist entry aliases and hot reloads
// share the same pending asks without weakening the per-instance identity
// checks below.
const PENDING_REGISTRY_KEY = Symbol.for('@forgeax/orchestrator/ask-user-registry/v1');
const EXTERNAL_RESOLVER_KEY = Symbol.for('@forgeax/orchestrator/ask-user-resolver/v1');
const processGlobals = globalThis as typeof globalThis & { [key: symbol]: unknown };
const existingPending = processGlobals[PENDING_REGISTRY_KEY];
const pending = existingPending instanceof Map
  ? existingPending as Map<string, Pending>
  : new Map<string, Pending>();
processGlobals[PENDING_REGISTRY_KEY] = pending;

/** Register the product-kernel resolver on globalThis so the package-root HTTP
 * graph can reach a pending ask owned by a second bundled package entry. */
export function setExternalAskReplyResolver(resolver: ExternalAskReplyResolver): void {
  processGlobals[EXTERNAL_RESOLVER_KEY] = resolver;
}

export async function resolveAskReply(
  sid: string,
  agentPath: string,
  values: AskReply | string[],
  identity: AskReplyIdentity = {},
): Promise<boolean> {
  if (resolveAsk(sid, agentPath, values, identity)) return true;
  const resolver = processGlobals[EXTERNAL_RESOLVER_KEY];
  return typeof resolver === 'function'
    ? Boolean(await (resolver as ExternalAskReplyResolver)(sid, agentPath, values, identity))
    : false;
}

export interface AskHandle {
  readonly requestId: string;
  /** Resolves to the chosen label array, or null when aborted / timed out. */
  readonly promise: Promise<AskResult | null>;
  /** Idempotent cleanup —— removes the pending entry + clears the timer. */
  dispose(): void;
}

export function registerAsk(owner: AskOwner, timeoutMs: number): AskHandle;
/** Legacy address-only overload. New runtime callers must provide instance
 * identity so stale UI replies cannot resolve a reloaded resident ask. */
export function registerAsk(sid: string, agentPath: string, timeoutMs: number): AskHandle;
export function registerAsk(
  ownerOrSid: AskOwner | string,
  agentPathOrTimeout: string | number,
  legacyTimeoutMs?: number,
): AskHandle {
  const owner: AskOwner = typeof ownerOrSid === "string"
    ? {
        sid: ownerOrSid,
        agentPath: agentPathOrTimeout as string,
        instanceId: `legacy:${ownerOrSid}:${agentPathOrTimeout}`,
        runtimeEpochId: "legacy",
      }
    : ownerOrSid;
  const timeoutMs = typeof agentPathOrTimeout === "number"
    ? agentPathOrTimeout
    : (legacyTimeoutMs ?? 0);
  // Legacy serial requests supersede their predecessor. Explicitly identified
  // concurrent requests stay independent. Superseding is scoped to
  // the exact epoch so an old turn cannot cancel a new resident epoch's ask.
  for (const entry of pending.values()) {
    if (
      !owner.requestId &&
      entry.sid === owner.sid &&
      entry.instanceId === owner.instanceId &&
      entry.runtimeEpochId === owner.runtimeEpochId
    ) {
      settle(entry, null);
    }
  }

  const requestId = owner.requestId ?? randomUUID();
  if (pending.has(requestId)) throw new Error("Duplicate pending ask request identity");
  let resolvePromise!: (values: AskResult | null) => void;
  const promise = new Promise<AskResult | null>((resolve) => {
    resolvePromise = resolve;
  });
  const timer =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          const entry = pending.get(requestId);
          if (entry) settle(entry, null);
        }, timeoutMs)
      : undefined;
  const entry: Pending = {
    ...owner,
    requestId,
    resolve: resolvePromise,
    ...(timer ? { timer } : {}),
  };
  pending.set(requestId, entry);
  tt("ask.register", { ...owner, requestId, timeoutMs });

  return {
    requestId,
    promise,
    dispose() {
      const current = pending.get(requestId);
      if (current) settle(current, null);
    },
  };
}

export function resolveAsk(
  sid: string,
  agentPath: string,
  values: AskReply | string[],
  identity: AskReplyIdentity = {},
): boolean {
  const candidates = identity.requestId
    ? [pending.get(identity.requestId)].filter(
        (entry): entry is Pending => Boolean(entry),
      )
    : [...pending.values()].filter((entry) => {
        if (entry.sid !== sid) return false;
        if (identity.instanceId && entry.instanceId !== identity.instanceId) {
          return false;
        }
        if (
          identity.runtimeEpochId &&
          entry.runtimeEpochId !== identity.runtimeEpochId
        ) {
          return false;
        }
        if (!identity.instanceId && entry.agentPath !== agentPath) return false;
        return true;
      });
  const entry = candidates.length === 1
    ? candidates[0]
    : !identity.requestId && !identity.instanceId
      ? onlyPendingForSession(sid)
      : undefined;
  const valid = Boolean(
    entry &&
      entry.sid === sid &&
      (!identity.requestId || !!identity.instanceId || entry.agentPath === agentPath) &&
      (!identity.instanceId || entry.instanceId === identity.instanceId) &&
      (
        !identity.runtimeEpochId ||
        entry.runtimeEpochId === identity.runtimeEpochId
      ),
  );
  tt("ask.resolve", {
    sid,
    agentPath,
    ...identity,
    found: valid,
    candidateCount: candidates.length,
  });
  if (!entry || !valid) return false;
  settle(entry, values);
  return true;
}

function onlyPendingForSession(sid: string): Pending | undefined {
  const matches = [...pending.values()].filter((entry) => entry.sid === sid);
  return matches.length === 1 ? matches[0] : undefined;
}

function settle(entry: Pending, values: AskResult | null): void {
  if (pending.get(entry.requestId) !== entry) return;
  pending.delete(entry.requestId);
  if (entry.timer) clearTimeout(entry.timer);
  entry.resolve(values);
}
