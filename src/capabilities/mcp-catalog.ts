import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commonCapabilityRoots } from './common-roots';

export interface CommonMcpServer {
  id: string;
  name?: string;
  version?: string;
  enabled: boolean;
  origin: 'user' | 'project';
  configPath: string;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
}

type RawMcpConfig = {
  servers?: Record<string, Omit<CommonMcpServer, 'id' | 'origin' | 'configPath'>>
    | Array<Omit<CommonMcpServer, 'origin' | 'configPath'>>;
};

function readConfig(dir: string, origin: CommonMcpServer['origin']): CommonMcpServer[] {
  const configPath = join(dir, 'mcp.json');
  if (!existsSync(configPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as RawMcpConfig;
    const entries = Array.isArray(parsed.servers)
      ? parsed.servers.map((server) => [server.id, server] as const)
      : Object.entries(parsed.servers ?? {});
    return entries
      .filter(([id]) => typeof id === 'string' && id.length > 0)
      .map(([id, server]) => ({
        id,
        name: server.name,
        version: server.version,
        enabled: server.enabled !== false,
        origin,
        configPath,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
      }));
  } catch {
    return [];
  }
}

/** Project overrides user by id, matching extension/command overlay semantics. */
export function listCommonMcpServers(projectRoot?: string): CommonMcpServer[] {
  const roots = commonCapabilityRoots(projectRoot);
  const byId = new Map<string, CommonMcpServer>();
  for (const server of readConfig(roots.user.mcp, 'user')) byId.set(server.id, server);
  for (const server of readConfig(roots.project.mcp, 'project')) byId.set(server.id, server);
  return [...byId.values()];
}
