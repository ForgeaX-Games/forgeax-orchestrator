import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnJsonl } from '../src/cli-providers/shared/subprocess-jsonl';

const fixtureDirs: string[] = [];

describe('spawnJsonl stdin EOF', () => {
  // Read fd 0 synchronously through EOF, as Codex exec does before starting a
  // turn. Bun is the host under bun test; no CLI login or model call is needed.
  for (const stdin of [undefined, '', 'prompt with unicode: \u4f60\u597d\n'.repeat(8192)]) {
    test(`closes stdin after ${stdin === undefined ? 'omitted input' : stdin === '' ? 'empty input' : 'a large payload'}`, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const { lines, exit } = spawnJsonl<{ input: string }>({
        cmd: process.execPath,
        args: ['-e', 'const fs = require("node:fs"); console.log(JSON.stringify({ input: fs.readFileSync(0, "utf8") }));'],
        stdin,
        signal: controller.signal,
        killGraceMs: 100,
      });
      try {
        const values = [];
        for await (const value of lines) values.push(value);
        expect(await exit).toEqual({ code: 0, stderr: '' });
        expect(controller.signal.aborted).toBe(false);
        expect(values).toEqual([{ input: stdin ?? '' }]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }, 4000);
  }
});

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jsonlCmdFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'subprocess jsonl cmd-'));
  fixtureDirs.push(dir);
  const script = join(dir, 'argv.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({ args: process.argv.slice(2) }));\n');
  const launcher = join(dir, 'jsonl.CMD');
  writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return launcher;
}

describe('spawnJsonl Windows launcher', () => {
  test.skipIf(process.platform !== 'win32')('streams JSON from a .CMD launcher', async () => {
    const args = ['-c', String.raw`mcp_servers.fxt.args=["C:\Program Files\ForgeaX\tool.mjs","A&B"]`];
    const controller = new AbortController();
    const { lines, exit } = spawnJsonl<{ args: string[] }>({
      cmd: jsonlCmdFixture(),
      args,
      signal: controller.signal,
    });
    const values: Array<{ args: string[] }> = [];
    for await (const value of lines) values.push(value);

    expect(values).toEqual([{ args }]);
    expect(await exit).toEqual({ code: 0, stderr: '' });
  });
});
