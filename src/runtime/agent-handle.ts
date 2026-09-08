import type { AgentTurnResult } from "./agent-runtime-controller";

export type AgentCompletion =
  | {
      readonly status: "completed";
      readonly result: AgentTurnResult;
      readonly releasedAt: number;
    }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly releasedAt: number;
    }
  | {
      readonly status: "cancelled";
      readonly reason?: string;
      readonly releasedAt: number;
    };

export interface AgentHandle {
  readonly instanceId: string;
  readonly completion: Promise<AgentCompletion>;
  wait(): Promise<AgentCompletion>;
  cancel(reason?: string): Promise<void>;
}

export class ManagedAgentHandle implements AgentHandle {
  readonly completion: Promise<AgentCompletion>;
  private resolveCompletion!: (completion: AgentCompletion) => void;
  private rejectCompletion!: (error: unknown) => void;
  private settled = false;

  constructor(
    readonly instanceId: string,
    private readonly cancelInstance: (reason?: string) => Promise<void>,
  ) {
    this.completion = new Promise<AgentCompletion>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  wait(): Promise<AgentCompletion> {
    return this.completion;
  }

  cancel(reason?: string): Promise<void> {
    return this.cancelInstance(reason);
  }

  settle(completion: AgentCompletion): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveCompletion(completion);
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectCompletion(error);
  }
}
