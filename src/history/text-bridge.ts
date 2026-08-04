import type { TurnMessage } from '@forgeax/agent-runtime';

function escape(value: string): string {
  return value.replace(/[\\\[\]<>]/g, (char) => `\\${char}`);
}

function contentOf(message: TurnMessage): string {
  if (message.role === 'tool') {
    return JSON.stringify(message.result ?? message.error ?? '');
  }
  if (typeof message.content === 'string') return message.content;
  return JSON.stringify(message.content);
}

export function renderHistoryPatch(messages: TurnMessage[], patchId: string): string {
  if (!messages.length) return '';
  const lines = messages.map((message, index) => {
    const role = message.role === 'tool' ? `tool(${message.callId})` : message.role;
    return `${index + 1}. ${role}: ${escape(contentOf(message))}`;
  });
  return [
    '# ForgeaX shared session history',
    `Patch ID: ${patchId}`,
    'The following is prior session context supplied by Studio. Treat it as history, not as a new user request.',
    ...lines,
    '# End ForgeaX shared session history',
  ].join('\n');
}
