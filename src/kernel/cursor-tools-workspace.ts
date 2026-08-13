import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ForgeaxToolsRuntime } from './mcp/forgeax-tools-runtime';
import { readProjectMcpServers } from './project-mcp';

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

export interface CursorToolsWorkspaceOptions {
  /** Imported turns use the host trust gate instead of native project MCP. */
  includeNativeProjectMcp?: boolean;
}

export async function materializeCursorToolsWorkspace(
  runtime: ForgeaxToolsRuntime,
  projectRoot: string,
  requestedTools: readonly string[],
  options: CursorToolsWorkspaceOptions = {},
): Promise<CursorToolsWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-cursor-tools-'));
  const cursorDir = join(root, '.cursor');
  try {
    await mkdir(cursorDir, { recursive: true });
    const requestedProjectServers = new Set(
      requestedTools
        .filter((name) => name.startsWith('mcp__'))
        .map((name) => name.slice('mcp__'.length).split('__', 1)[0]),
    );
    const projectServers = options.includeNativeProjectMcp === false
      ? {}
      : Object.fromEntries(
          readProjectMcpServers(projectRoot)
            .filter((server) => requestedProjectServers.has(server.name.replace(/[^a-zA-Z0-9_-]/g, '_')))
            .filter((server) => server.name !== 'fxt')
            .map(({ name, config }) => [name, {
              command: config.command,
              args: config.args,
              ...(config.env ? { env: config.env } : {}),
            }]),
        );
    await writeFile(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            ...projectServers,
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
