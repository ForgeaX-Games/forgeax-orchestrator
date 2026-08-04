import type { TurnMessage } from '@forgeax/agent-runtime';
import type { HistoryEntry } from './types';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key|cookie|credential|cwd|workspace|absolute[_-]?path)/i;
const SENSITIVE_TEXT = /(Bearer\s+)[A-Za-z0-9._~+/=-]+|\b(sk|rk|sess|token|secret)[-_][A-Za-z0-9._-]{8,}/gi;

function redactValue(value: unknown, key?: string): { value: unknown; count: number } {
  if (key && SENSITIVE_KEY.test(key)) return { value: REDACTED, count: 1 };
  if (typeof value === 'string') {
    let count = 0;
    const next = value.replace(SENSITIVE_TEXT, (match, prefix?: string) => {
      count += 1;
      return prefix ? `${prefix}${REDACTED}` : REDACTED;
    });
    return { value: next, count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const next = value.map((item) => {
      const redacted = redactValue(item);
      count += redacted.count;
      return redacted.value;
    });
    return { value: next, count };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    const next: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const redacted = redactValue(childValue, childKey);
      count += redacted.count;
      next[childKey] = redacted.value;
    }
    return { value: next, count };
  }
  return { value, count: 0 };
}

export function redactHistoryEntries(items: HistoryEntry[]): { items: HistoryEntry[]; redactedParts: number } {
  let redactedParts = 0;
  const next = items.map((item) => {
    const redacted = redactValue(item.message);
    redactedParts += redacted.count;
    return { ...item, message: redacted.value as TurnMessage };
  });
  return { items: next, redactedParts };
}
