import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSpawnInvocation, resolveRuntimeLaunch, runCapture } from '../src/lib/node-spawn';

const fixtureDirs: string[] = [];

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('prepareSpawnInvocation', () => {
  test('keeps direct executable argv unchanged', () => {
    expect(prepareSpawnInvocation('/usr/local/bin/codex', ['app-server'], 'darwin')).toEqual({
      command: '/usr/local/bin/codex',
      args: ['app-server'],
    });
  });

  test('escapes every argv item before routing a Windows batch launcher through cmd.exe', () => {
    const invocation = prepareSpawnInvocation(
      String.raw`C:\Users\Forge User\codex.CMD`,
      ['-c', String.raw`mcp_servers.fxt.args=["C:\Program Files\ForgeaX\tool.mjs","A&B"]`, 'app-server'],
      'win32',
    );

    expect(invocation).toEqual({
      command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        String.raw`"C:\Users\Forge^ User\codex.CMD ^^^"-c^^^" ^^^"mcp_servers.fxt.args=^^^[\^^^"C:\Program^^^ Files\ForgeaX\tool.mjs\^^^"^^^,\^^^"A^^^&B\^^^"^^^]^^^" ^^^"app-server^^^""`,
      ],
      windowsVerbatimArguments: true,
    });
  });
});

describe('resolveRuntimeLaunch', () => {
  test('uses the desktop bundled Bun instead of the compiled server executable', () => {
    const previous = process.env.FORGEAX_BUN_EXECUTABLE;
    process.env.FORGEAX_BUN_EXECUTABLE = '/Applications/ForgeaX Studio.app/Contents/MacOS/bun';
    try {
      expect(resolveRuntimeLaunch('/bundle/server-runtime/agent-host.mjs', ['--serve'])).toEqual({
        cmd: '/Applications/ForgeaX Studio.app/Contents/MacOS/bun',
        args: ['/bundle/server-runtime/agent-host.mjs', '--serve'],
      });
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_BUN_EXECUTABLE;
      else process.env.FORGEAX_BUN_EXECUTABLE = previous;
    }
  });

  test('keeps the ordinary Bun source-development launch unchanged', () => {
    const previous = process.env.FORGEAX_BUN_EXECUTABLE;
    delete process.env.FORGEAX_BUN_EXECUTABLE;
    try {
      expect(resolveRuntimeLaunch('/workspace/agent-host.ts')).toEqual({
        cmd: process.execPath || 'bun',
        args: ['/workspace/agent-host.ts'],
      });
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_BUN_EXECUTABLE;
      else process.env.FORGEAX_BUN_EXECUTABLE = previous;
    }
  });
});

describe('runCapture', () => {
  test.skipIf(process.platform !== 'win32')('preserves complex argv through a Windows batch launcher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'node spawn cmd-'));
    fixtureDirs.push(dir);
    const script = join(dir, 'argv.mjs');
    const launcher = join(dir, 'argv.CMD');
    writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const args = ['-c', String.raw`mcp_servers.fxt.args=["C:\Program Files\ForgeaX\tool.mjs","A&B"]`];

    const result = await runCapture(launcher, args, { captureStderr: true });

    expect(result).toEqual({ code: 0, stdout: `${JSON.stringify(args)}\n`, stderr: '' });
  });

  test('reports a bounded child timeout distinctly', async () => {
    const started = Date.now();
    const result = await runCapture(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 100,
    });

    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('cleans up descendants when the launcher times out', async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });',
      'console.log(child.pid);',
      'setTimeout(() => {}, 10000);',
    ].join('');
    const result = await runCapture(process.execPath, ['-e', script], { timeoutMs: 100 });
    const descendantPid = Number(result.stdout.trim());

    expect(result.timedOut).toBe(true);
    expect(descendantPid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    let descendantAlive = false;
    try {
      process.kill(descendantPid, 0);
      descendantAlive = true;
    } catch {
      // The detached process group should have taken the descendant down.
    } finally {
      if (descendantAlive) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
    expect(descendantAlive).toBe(false);
  });

  test('does not mark normally completed commands as timed out', async () => {
    const result = await runCapture(process.execPath, ['-e', 'process.stdout.write("ok")']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.timedOut).toBeUndefined();
  });
});
