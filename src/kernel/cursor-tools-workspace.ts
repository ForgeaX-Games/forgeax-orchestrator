import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ForgeaxToolsRuntime } from './mcp/forgeax-tools-runtime';

/**
 * Cursor Agent discovers project MCP servers only from `<workspace>/.cursor/mcp.json`.
 * It has no per-invocation MCP argument, so a tools turn gets a short-lived workspace
 * containing exactly this turn's fxt server. The real Studio project is passed through
 * `--add-dir`; the fxt process itself still receives the real project root in its env.
 *
 * This avoids rewriting a user's `.cursor/mcp.json`, which would both race concurrent
 * turns and leak one turn's tool set into another.
 */
export interface CursorToolsWorkspace {
  readonly root: string;
  cleanup(): Promise<void>;
}

export async function materializeCursorToolsWorkspace(
  runtime: ForgeaxToolsRuntime,
): Promise<CursorToolsWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-cursor-tools-'));
  const cursorDir = join(root, '.cursor');
  try {
    await mkdir(cursorDir, { recursive: true });
    await writeFile(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            fxt: {
              command: runtime.command,
              args: runtime.args,
              env: runtime.env,
            },
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}
