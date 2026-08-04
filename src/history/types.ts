import type { TurnMessage } from '@forgeax/agent-runtime';

export interface HistoryCursor {
  shard: number;
  line: number;
  eventId: string;
}

export type HistoryMode = 'none' | 'snapshot' | 'delta' | 'authoritative';

export interface KernelLane {
  laneId: string;
  kernelId: string;
  epoch: number;
  nativeSessionRef?: string;
  knownThrough?: HistoryCursor;
  invalidated?: boolean;
}

export interface HistoryEntry {
  cursor: HistoryCursor;
  ts?: number;
  turnId: string;
  message: TurnMessage;
  kernelId?: string;
  semanticBoundary?: 'compaction' | 'rewind' | 'policy-change';
}

export interface PreparedHistory {
  mode: HistoryMode;
  messages: TurnMessage[];
  lane: KernelLane;
  from?: HistoryCursor;
  through?: HistoryCursor;
  patchId: string;
  estimatedTokens: number;
  redactedParts: number;
}

export interface HistoryUnavailable {
  code: 'history_unavailable';
  message: string;
  retryable: boolean;
}
