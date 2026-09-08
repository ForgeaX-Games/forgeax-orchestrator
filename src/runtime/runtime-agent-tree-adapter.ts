import type {
  AgentNode,
  AgentTreeAPI,
  TreeChange,
} from "../core/types";
import type { AgentInstance } from "./types";
import { RuntimeTree } from "./runtime-tree";

/**
 * Compatibility projection for kits and existing HTTP/UI code. It is a view
 * over RuntimeTree, never a second topology index and never reads the
 * filesystem.
 */
export class RuntimeAgentTreeAdapter implements AgentTreeAPI {
  constructor(
    readonly sid: string,
    private readonly runtimeTree: RuntimeTree,
  ) {}

  get(path: string): AgentNode | undefined {
    const instance = this.resolve(path);
    return instance ? this.toNode(instance) : undefined;
  }

  getByFullId(fullId: string): AgentNode | undefined {
    return this.list().find((node) => node.fullId === fullId);
  }

  findByDisplay(display: string): AgentNode {
    const matches = this.list().filter((node) => node.display === display);
    if (matches.length === 0) {
      throw new Error(`RuntimeTree: no agent with display='${display}'`);
    }
    if (matches.length > 1) {
      throw new Error(
        `RuntimeTree: ambiguous display='${display}' (candidates: ${
          matches.map((node) => node.fullId).join(", ")
        }); use fullId`,
      );
    }
    return matches[0]!;
  }

  parent(path: string): AgentNode | undefined {
    const instance = this.resolve(path);
    if (!instance) return undefined;
    const parent = this.runtimeTree.parentOf(instance.instanceId);
    return parent ? this.toNode(parent) : undefined;
  }

  children(path: string): AgentNode[] {
    const instance = this.resolve(path);
    if (!instance) return [];
    return this.runtimeTree
      .childrenOf(instance.instanceId)
      .map((child) => this.toNode(child));
  }

  list(): AgentNode[] {
    return this.runtimeTree.list().map((instance) => this.toNode(instance));
  }

  getWritablePaths(path: string): string[] {
    const node = this.get(path);
    if (!node) return [];
    return [
      `${node.path}/`,
      ...this.children(path).map((child) => `${child.path}/`),
      "shared-workspace/",
    ];
  }

  onChange(handler: (changes: TreeChange[]) => void): () => void {
    return this.runtimeTree.onChange((change) => {
      if (change.kind === "updated") return;
      handler([{
        kind: change.kind === "inserted" ? "added" : "removed",
        node: this.toNode(change.instance),
      }]);
    });
  }

  resolve(pathOrInstanceId: string): AgentInstance | undefined {
    return this.runtimeTree.get(pathOrInstanceId)
      ?? this.runtimeTree.findResident(pathOrInstanceId);
  }

  addressOf(instance: AgentInstance): string {
    return instance.residentPath ?? instance.instanceId;
  }

  private toNode(instance: AgentInstance): AgentNode {
    const path = this.addressOf(instance);
    const parent = instance.parentInstanceId
      ? this.runtimeTree.get(instance.parentInstanceId)
      : undefined;
    const display = instance.template.definition.displayName
      ?? instance.template.definition.id
      ?? path.split("/").at(-1)
      ?? path;
    const depth = this.depthOf(instance);
    return {
      path,
      display,
      depth,
      fullId: instance.lifetime === "resident"
        ? `${display}#${depth}`
        : `${display}#${depth}:${instance.instanceId}`,
      ...(parent ? { parent: this.addressOf(parent) } : {}),
    };
  }

  private depthOf(instance: AgentInstance): number {
    return this.runtimeTree.depthOf(instance.instanceId);
  }
}
