/**
 * Real the reference agent CLI tools E2E. This file intentionally stays outside bun:test:
 * it invokes the locally authenticated the reference agent CLI runtime and a real model.
 */
import { randomUUID } from 'node:crypto';
import { ClaudeCodeKernel } from '../src/kernel/claude-code-kernel';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail });
};

async function main(): Promise<void> {
  const kernel = new ClaudeCodeKernel();
  const health = await kernel.probe();
  check('probe · the reference agent CLI binary ready', health.ok, health.detail ?? '');

  const token = `CCX-${randomUUID().slice(0, 8)}`;
  const request: TurnRequest = {
    session: { threadId: randomUUID(), agentId: 'forge' },
    hostSessionId: `claude-tools-e2e-${Date.now()}`,
    input: { text: `Call the echo tool with text set to "${token}". Then reply with exactly the tool result.` },
    systemPrompt: {
      charter: 'You are a terse test agent. You must call the requested tool before replying.',
      persona: '',
      mode: 'replace',
    },
    tools: [{ name: 'echo', description: 'Echo back the given text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    budget: { maxTurns: 4 },
    trustTier: 'imported',
  };
  const events: KernelEvent[] = [];
  for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);
  const call = events.find((event): event is Extract<KernelEvent, { kind: 'tool.call' }> => event.kind === 'tool.call' && event.name.includes('echo'));
  const result = events.find((event): event is Extract<KernelEvent, { kind: 'tool.result' }> =>
    event.kind === 'tool.result' && event.ok && JSON.stringify(event.result ?? '').includes(`[forgeax_echo] ${token}`),
  );
  const error = events.find((event) => event.kind === 'error');
  check(
    'tool turn · echo delivered → invoked → executed (fxt MCP round-trip)',
    Boolean(call) && Boolean(result) && !error,
    `call=${Boolean(call)} result=${Boolean(result)} error=${error ? JSON.stringify(error) : 'none'} token=${token}`,
  );
}

main()
  .then(() => {
    let failures = 0;
    console.log('\n========== claude-code kernel e2e ==========');
    for (const result of results) {
      if (!result.ok) failures++;
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : ` -- ${result.detail}`}`);
    }
    console.log(`${results.length - failures}/${results.length} passed`);
    process.exit(failures);
  })
  .catch((error) => {
    console.error('claude-code e2e crashed:', error);
    process.exit(1);
  });
