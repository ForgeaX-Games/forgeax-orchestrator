import type {
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type {
  KernelEvent,
  PermissionCall,
  PermissionDecision,
  TurnDoneReason,
} from '@forgeax/agent-runtime';

interface ToolState {
  name: string;
  args: unknown;
  emitted: boolean;
  done: boolean;
}

export interface KimiAcpMapperState {
  tools: Map<string, ToolState>;
}

export function createKimiAcpMapperState(): KimiAcpMapperState {
  return { tools: new Map() };
}

function toolName(update: {
  title?: string | null;
  kind?: ToolKind | null;
  _meta?: Record<string, unknown> | null;
}): string {
  const programmatic = update._meta?.toolName ?? update._meta?.tool_name;
  if (typeof programmatic === 'string' && programmatic.trim()) return programmatic.trim();
  if (update.title?.trim() && /^(Bash|Edit|Read|Grep|Glob|WebFetch|WebSearch|Think)$/i.test(update.title.trim())) {
    const title = update.title.trim();
    return title.charAt(0).toUpperCase() + title.slice(1);
  }
  switch (update.kind) {
    case 'read':
      return 'Read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'Edit';
    case 'search':
      return 'Grep';
    case 'execute':
      return 'Bash';
    case 'fetch':
      return 'WebFetch';
    case 'think':
      return 'Think';
    default:
      return 'tool';
  }
}

function contentValue(content: ToolCallContent[] | null | undefined): unknown {
  if (!content?.length) return '';
  const parts: string[] = [];
  for (const entry of content) {
    if (entry.type === 'content' && entry.content.type === 'text') {
      parts.push(entry.content.text);
    } else if (entry.type === 'diff') {
      parts.push(entry.newText);
    }
  }
  return parts.join('\n');
}

function toolArgs(update: { rawInput?: unknown; content?: ToolCallContent[] | null }): unknown {
  if (update.rawInput !== undefined) return update.rawInput;
  const text = contentValue(update.content);
  if (typeof text !== 'string' || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { input: text };
  }
}

function openTool(
  state: KimiAcpMapperState,
  update: {
    toolCallId: string;
    title?: string | null;
    kind?: ToolKind | null;
    rawInput?: unknown;
    content?: ToolCallContent[] | null;
    _meta?: Record<string, unknown> | null;
  },
): KernelEvent[] {
  const existing = state.tools.get(update.toolCallId);
  const current: ToolState = existing ?? {
    name: toolName(update),
    args: toolArgs(update),
    emitted: false,
    done: false,
  };
  if (update.rawInput !== undefined || update.content !== undefined) current.args = toolArgs(update);
  state.tools.set(update.toolCallId, current);
  if (current.emitted) return [];
  current.emitted = true;
  return [{ kind: 'tool.call', callId: update.toolCallId, name: current.name, args: current.args }];
}

function finishTool(
  state: KimiAcpMapperState,
  update: {
    toolCallId: string;
    title?: string | null;
    kind?: ToolKind | null;
    rawInput?: unknown;
    rawOutput?: unknown;
    content?: ToolCallContent[] | null;
    status?: string | null;
    _meta?: Record<string, unknown> | null;
  },
): KernelEvent[] {
  const out = openTool(state, update);
  const current = state.tools.get(update.toolCallId)!;
  if (current.done) return out;
  current.done = true;
  const result = update.rawOutput !== undefined ? update.rawOutput : contentValue(update.content);
  out.push(
    update.status === 'failed'
      ? {
          kind: 'tool.result',
          callId: update.toolCallId,
          ok: false,
          error: typeof result === 'string' ? result : JSON.stringify(result),
        }
      : { kind: 'tool.result', callId: update.toolCallId, ok: true, result },
  );
  return out;
}

export function mapKimiAcpUpdate(
  update: SessionUpdate,
  state: KimiAcpMapperState,
): KernelEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text' && update.content.text
        ? [{ kind: 'message.delta', role: 'assistant', text: update.content.text }]
        : [];
    case 'agent_thought_chunk':
      return update.content.type === 'text' && update.content.text
        ? [{ kind: 'thinking.delta', text: update.content.text }]
        : [];
    case 'tool_call': {
      const out = openTool(state, update);
      if (update.status === 'completed' || update.status === 'failed') {
        out.push(...finishTool(state, update));
      }
      return out;
    }
    case 'tool_call_update':
      if (update.status === 'completed' || update.status === 'failed') {
        return finishTool(state, update);
      }
      return openTool(state, update);
    default:
      return [];
  }
}

export function mapKimiAcpPromptResponse(response: PromptResponse): KernelEvent[] {
  const usage = response.usage;
  return [
    {
      kind: 'turn.usage',
      ...(usage ? {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(typeof usage.cachedReadTokens === 'number' ? { cacheRead: usage.cachedReadTokens } : {}),
        ...(typeof usage.cachedWriteTokens === 'number' ? { cacheCreation: usage.cachedWriteTokens } : {}),
      } : {}),
    },
    { kind: 'turn.done', reason: kimiAcpStopReason(response.stopReason) },
  ];
}

export function kimiAcpStopReason(reason: PromptResponse['stopReason']): TurnDoneReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'max_tokens';
    case 'max_turn_requests':
      return 'max_turns';
    case 'cancelled':
      return 'cancelled';
    case 'refusal':
    default:
      return 'error';
  }
}

export function permissionCallFromAcp(req: RequestPermissionRequest): PermissionCall {
  return {
    name: req.toolCall.title?.trim() || 'tool',
    args: req.toolCall.rawInput ?? {},
  };
}

export function selectKimiPermissionOption(
  options: readonly PermissionOption[],
  decision: PermissionDecision,
): string | null {
  const kinds = decision.behavior === 'allow'
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  return options.find((option) => kinds.includes(option.kind))?.optionId ?? null;
}
