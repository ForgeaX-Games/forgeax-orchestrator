import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFileSystemAgentTemplate } from '../src/agents/agent-template-loader';

test('resident template loading preserves explicit mode and leaves absence inheritable', () => {
  const root = mkdtempSync(join(tmpdir(), 'permission-loader-'));
  try {
    writeFileSync(join(root, 'agent.json'), JSON.stringify({ permissionMode: 'planning' }));
    expect(loadFileSystemAgentTemplate(root, 'suzu').runtimeConfigDefaults.permissionMode).toBe('planning');
    writeFileSync(join(root, 'agent.json'), '{}');
    expect(loadFileSystemAgentTemplate(root, 'suzu').runtimeConfigDefaults.permissionMode).toBeUndefined();
    writeFileSync(join(root, 'agent.json'), JSON.stringify({ permissionMode: 'typo' }));
    expect(() => loadFileSystemAgentTemplate(root, 'suzu')).toThrow('invalid agent permissionMode');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
