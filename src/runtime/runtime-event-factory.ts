import { randomUUID } from "node:crypto";
import type { StoredEvent } from "../ledger/types";
import type { AgentInstance } from "./types";

/**
 * Session-scoped lifecycle event sequencer. Registration, supervision and
 * disposal share this instance so one Session never creates competing seq
 * streams for runtime-owned events.
 */
export class RuntimeEventFactory {
  private sequence = 0;
  private readonly sgen = randomUUID();

  constructor(private readonly sid: string) {}

  agent(
    instance: AgentInstance,
    type: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): StoredEvent {
    return {
      eventId: randomUUID(),
      type,
      ts: Date.now(),
      source: "runtime",
      seq: ++this.sequence,
      sgen: this.sgen,
      owner: {
        kind: "agent",
        instanceId: instance.instanceId,
        runtimeEpochId: instance.runtimeEpochId,
      },
      agentInstanceId: instance.instanceId,
      runtimeEpochId: instance.runtimeEpochId,
      payload: {
        sid: this.sid,
        instanceId: instance.instanceId,
        runtimeEpochId: instance.runtimeEpochId,
        ...payload,
      },
    };
  }
}
