import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getPathManager } from '../fs/path-manager';

/** Canonical user/project locations for capabilities shared by every kernel. */
export function commonCapabilityRoots(projectRoot = defaultProjectRoot()) {
  const userRoot = getPathManager().user().root() || join(homedir(), '.forgeax');
  return {
    user: {
      root: userRoot,
      extensions: join(userRoot, 'extensions'),
      commands: join(userRoot, 'commands'),
      mcp: join(userRoot, 'mcp'),
    },
    project: {
      root: join(projectRoot, '.forgeax'),
      extensions: join(projectRoot, '.forgeax', 'extensions'),
      commands: join(projectRoot, '.forgeax', 'commands'),
      mcp: join(projectRoot, '.forgeax', 'mcp'),
    },
  } as const;
}
