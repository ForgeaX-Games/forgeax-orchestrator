export interface AgentRuntimeContext {
  readonly workspaceRoot: string;
  /** Instance-owned writable state. Never points at an author template. */
  readonly runtimeStateRoot: string;
  readonly runtimeStateRef: string;
  /** Read-only authoring resources captured when the instance was registered. */
  readonly templateRoot?: string;
}

export interface EnsureResidentOptions {
  /** Model selected by the delegating resident, copied only on first scaffold. */
  readonly model?: string | string[];
}

export interface RuntimeToolContext {
  readonly sid: string;
  readonly instanceId: string;
  readonly runtimeEpochId: string;
  readonly templateRef: string;
  readonly workspaceRoot: string;
  /** Create an idle ephemeral child. Creation never starts a turn. */
  readonly createChild: (
    templateRef: string,
  ) => Promise<{ readonly instanceId: string }>;
  /** Queue one turn on an already-live Agent; cannot create or reparent it.
   *  Resolves once its Controller accepts the input, not when the turn ends. */
  readonly sendToAgent: (
    agentAddress: string,
    input: unknown,
  ) => Promise<void>;
  /** Lazily materialize a known plugin/marketplace persona as a resident Agent
   *  if it isn't in the tree yet (same bridge `POST /messages` uses); resolves
   *  to its address. Idempotent — an id already in the tree resolves immediately.
   *  Rejects if `agentId` isn't a discoverable persona (never auto-invents one). */
  readonly ensureResident: (
    agentId: string,
    options?: EnsureResidentOptions,
  ) => Promise<string>;
  readonly listChildren: () => readonly {
    readonly instanceId: string;
    readonly templateRef: string;
    readonly lifetime: "resident" | "ephemeral";
    readonly state: string;
  }[];
  readonly listTemplates: () => readonly {
    readonly templateRef: string;
    readonly entryId: string;
  }[];
}
