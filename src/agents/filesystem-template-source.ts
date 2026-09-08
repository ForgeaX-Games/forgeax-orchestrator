import { realpathSync, statSync } from "node:fs";
import { loadFileSystemAgentTemplate } from "./agent-template-loader";
import type { AgentTemplateSource } from "./template-source";
import type { TemplateSourceLocator } from "./template-source-locator";

export interface FileSystemTemplateSourceOptions {
  readonly sourceId: string;
  readonly root: string;
}

export class FileSystemTemplateSource implements AgentTemplateSource {
  readonly locator: Extract<TemplateSourceLocator, { medium: "filesystem" }>;

  constructor(options: FileSystemTemplateSourceOptions) {
    const root = realpathSync(options.root);
    if (!statSync(root).isDirectory()) {
      throw new Error(`template source root is not a directory: ${options.root}`);
    }
    this.locator = Object.freeze({
      medium: "filesystem",
      sourceId: requireSourceId(options.sourceId),
      root,
    });
  }

  async load(entryId: string) {
    return loadFileSystemAgentTemplate(this.locator.root, entryId);
  }
}

function requireSourceId(sourceId: string): string {
  if (!sourceId.trim()) throw new Error("template sourceId may not be empty");
  return sourceId;
}
