import type { ResidentLogicalPath } from "../fs/resident-agent-path";
import type { FrozenAgentTemplate, TemplateRef } from "../agents/template-types";
import type { AgentRuntimeContext } from "./runtime-context";
import type { RuntimeConfigBinding } from "./runtime-config";
import type { AgentExecutionBinding } from "./agent-execution";
import type { InstanceEventBinding } from "../ledger/types";

export type SessionId = string;
export type AgentInstanceId = string;
export type RuntimeEpochId = string;
export type AgentLifetime = "resident" | "ephemeral";
export type AgentRuntimeState =
  | "registered"
  | "idle"
  | "running"
  | "waiting_children"
  | "draining"
  | "cancelled"
  | "failed"
  | "disposed";

export interface AgentInstance {
  readonly sid: SessionId;
  readonly instanceId: AgentInstanceId;
  readonly runtimeEpochId: RuntimeEpochId;
  readonly templateRef: TemplateRef;
  readonly parentInstanceId: AgentInstanceId | null;
  readonly lifetime: AgentLifetime;
  readonly residentPath?: ResidentLogicalPath;
  readonly template: FrozenAgentTemplate;
  readonly runtime: AgentRuntimeContext;
  readonly runtimeConfig: RuntimeConfigBinding;
  readonly execution: AgentExecutionBinding;
  readonly events: InstanceEventBinding;
  readonly createdAt: number;
  state: AgentRuntimeState;
}

export interface RuntimeBindingKey {
  readonly sid: SessionId;
  readonly instanceId: AgentInstanceId;
  readonly runtimeEpochId: RuntimeEpochId;
}
