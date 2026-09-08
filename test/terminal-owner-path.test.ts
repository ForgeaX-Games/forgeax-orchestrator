import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { terminalOwnerDirectory } from '../src/terminal/owner-directory';

const owner = '87d7943b-d2d5-4bba-b88e-75a656fab219:res_45876d6c2ca393ff96fb4ff04ceb2668:epoch_d5821ee2b2e94ee7be9ed62ccf496d56';

describe('terminal owner cache paths', () => {
  test.each([owner, 'a/b', 'a\\b', 'a:b', 'CON', '..', 'trailing. ', 'a<>"|?*\x00', 'x'.repeat(1000)])(
    'maps owner %s to a bounded Windows-safe directory', (id) => {
      const segment = terminalOwnerDirectory(id);
      expect(segment).toMatch(/^agent-[a-f0-9]{64}$/);
      expect(terminalOwnerDirectory(id)).toBe(segment);
      const base = 'C:\\Users\\test\\ForgeaxProjects\\.forgeax\\state\\cache\\terminals';
      expect(win32.dirname(win32.join(base, segment))).toBe(base);
    },
  );

  test('preserves ownership without separator, case, or epoch collisions', () => {
    const ids = [owner, `${owner}-next`, owner.replace('res_', 'res_other'), owner.replace('87d7943b', '97d7943b'), 'a/b', 'a__b', 'a:b', 'a_b', 'A', 'a'];
    expect(new Set(ids.map(terminalOwnerDirectory)).size).toBe(ids.length);
  });

  test('creates shell-state files for the reported owner on the host filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-owner-'));
    try {
      const logDir = join(root, terminalOwnerDirectory(owner));
      const stateFile = join(logDir, '.shell_state', 'cwd');
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, root);
      expect(await readFile(stateFile, 'utf8')).toBe(root);
      expect(dirname(logDir)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('TerminalManager executes shell commands with the reported owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-owner-exec-'));
    try {
      // Isolate the unrelated product-root provider, not the manager, filesystem
      // or shell. A subprocess prevents this mock leaking into other test files.
      const script = `
        import { mock } from 'bun:test';
        import { strict as assert } from 'node:assert';
        import { basename, dirname } from 'node:path';
        mock.module('@forgeax/platform-io', () => ({ defaultProjectRoot: () => ${JSON.stringify(root)} }));
        const { initPathManager } = await import('./src/fs/path-manager.ts');
        const { TerminalManager } = await import('./src/terminal/manager.ts');
        initPathManager({ userRoot: ${JSON.stringify(root)}, projectRoot: ${JSON.stringify(root)} });
        const manager = new TerminalManager();
        try {
          const result = await manager.exec('printf TERMINAL_OWNER_OK', {
            agentId: ${JSON.stringify(owner)}, initialCwd: ${JSON.stringify(root)}, timeout: 5000,
          });
          assert.equal(result.exitCode, 0);
          assert.match(result.stdout, /TERMINAL_OWNER_OK/);
          assert.equal(basename(dirname(result.logFile)), ${JSON.stringify(terminalOwnerDirectory(owner))});
        } finally { manager.cleanup(0); }
      `;
      const child = spawnSync(process.execPath, ['-e', script], {
        cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 10000,
      });
      expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({
        status: 0, error: undefined, stderr: '',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
