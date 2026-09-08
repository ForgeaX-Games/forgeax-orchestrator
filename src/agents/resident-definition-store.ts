import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  deriveResidentInstanceId,
  ResidentPathCodec,
  type ResidentLogicalPath,
} from "../fs/resident-agent-path";

export interface ResidentIdentity {
  readonly sid: string;
  readonly logicalPath: ResidentLogicalPath;
  readonly instanceId: string;
}

export interface ResidentDefinition {
  readonly identity: ResidentIdentity;
  readonly logicalPath: ResidentLogicalPath;
  readonly parentLogicalPath: ResidentLogicalPath | null;
  readonly templateRoot: string;
}

export class ResidentDefinitionStore {
  private readonly byPath: ReadonlyMap<ResidentLogicalPath, ResidentDefinition>;
  private readonly ordered: readonly ResidentDefinition[];

  private constructor(
    readonly sid: string,
    readonly agentsRoot: string,
    definitions: readonly ResidentDefinition[],
  ) {
    this.ordered = Object.freeze([...definitions]);
    this.byPath = new Map(definitions.map((definition) => [
      definition.logicalPath,
      definition,
    ]));
  }

  static scan(
    sid: string,
    agentsRoot: string,
    codec = new ResidentPathCodec(),
  ): ResidentDefinitionStore {
    if (!sid.trim()) throw new Error("resident definition sid may not be empty");
    const canonicalRoot = realpathSync(agentsRoot);
    if (!statSync(canonicalRoot).isDirectory()) {
      throw new Error(`resident agents root is not a directory: ${agentsRoot}`);
    }
    const definitions: ResidentDefinition[] = [];

    const walk = (
      physicalAgentsDir: string,
      parentLogicalPath: ResidentLogicalPath | null,
    ) => {
      for (const name of listDirectoryNames(physicalAgentsDir)) {
        const root = join(physicalAgentsDir, name);
        if (!lstatSync(root).isDirectory()) continue;
        const logicalPath = codec.normalizeLogicalPath(
          parentLogicalPath ? `${parentLogicalPath}/${name}` : name,
        );
        definitions.push(Object.freeze({
          identity: Object.freeze({
            sid,
            logicalPath,
            instanceId: deriveResidentInstanceId(sid, logicalPath),
          }),
          logicalPath,
          parentLogicalPath,
          templateRoot: realpathSync(root),
        }));
        const childrenRoot = join(root, "agents");
        try {
          if (lstatSync(childrenRoot).isDirectory()) walk(childrenRoot, logicalPath);
        } catch {
          // no resident children
        }
      }
    };

    walk(canonicalRoot, null);
    return new ResidentDefinitionStore(sid, canonicalRoot, definitions);
  }

  list(): readonly ResidentDefinition[] {
    return this.ordered;
  }

  get(logicalPath: ResidentLogicalPath): ResidentDefinition | undefined {
    return this.byPath.get(logicalPath);
  }

  childrenOf(
    parentLogicalPath: ResidentLogicalPath | null,
  ): readonly ResidentDefinition[] {
    return this.ordered.filter(
      (definition) => definition.parentLogicalPath === parentLogicalPath,
    );
  }
}

function listDirectoryNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && name !== "events")
    .sort();
}
