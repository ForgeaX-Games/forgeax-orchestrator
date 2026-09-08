import type {
  AgentInstance,
  AgentInstanceId,
  SessionId,
} from "./types";

export type RuntimeTreeChange =
  | { readonly kind: "inserted"; readonly instance: AgentInstance }
  | {
      readonly kind: "removed";
      readonly instance: AgentInstance;
      readonly reason?: string;
    }
  | { readonly kind: "updated"; readonly instance: AgentInstance };

export class RuntimeTree {
  private readonly instances = new Map<AgentInstanceId, AgentInstance>();
  private readonly children = new Map<AgentInstanceId | null, Set<AgentInstanceId>>();
  private readonly listeners = new Set<(change: RuntimeTreeChange) => void>();

  constructor(readonly sid: SessionId) {}

  insert(instance: AgentInstance): void {
    this.assertTopology();
    if (instance.sid !== this.sid) {
      throw new Error(`RuntimeTree session mismatch: ${instance.sid} !== ${this.sid}`);
    }
    if (this.instances.has(instance.instanceId)) {
      throw new Error(`RuntimeTree duplicate instanceId: ${instance.instanceId}`);
    }
    if (instance.parentInstanceId === instance.instanceId) {
      throw new Error(`RuntimeTree self-parent cycle: ${instance.instanceId}`);
    }
    if (
      instance.parentInstanceId !== null &&
      !this.instances.has(instance.parentInstanceId)
    ) {
      throw new Error(`RuntimeTree parent not found: ${instance.parentInstanceId}`);
    }
    this.instances.set(instance.instanceId, instance);
    let siblings = this.children.get(instance.parentInstanceId);
    if (!siblings) {
      siblings = new Set();
      this.children.set(instance.parentInstanceId, siblings);
    }
    siblings.add(instance.instanceId);
    this.children.set(instance.instanceId, new Set());
    this.assertTopology();
    this.emit({ kind: "inserted", instance });
  }

  get(instanceId: AgentInstanceId): AgentInstance | undefined {
    return this.instances.get(instanceId);
  }

  findResident(logicalPath: string): AgentInstance | undefined {
    return [...this.instances.values()].find(
      (instance) =>
        instance.lifetime === "resident" &&
        instance.residentPath === logicalPath,
    );
  }

  parentOf(instanceId: AgentInstanceId): AgentInstance | undefined {
    this.assertTopology();
    const parentId = this.instances.get(instanceId)?.parentInstanceId;
    return parentId ? this.instances.get(parentId) : undefined;
  }

  childrenOf(instanceId: AgentInstanceId): readonly AgentInstance[] {
    this.assertTopology();
    return [...(this.children.get(instanceId) ?? [])]
      .map((childId) => this.instances.get(childId))
      .filter((instance): instance is AgentInstance => Boolean(instance));
  }

  roots(): readonly AgentInstance[] {
    this.assertTopology();
    return [...(this.children.get(null) ?? [])]
      .map((instanceId) => this.instances.get(instanceId))
      .filter((instance): instance is AgentInstance => Boolean(instance));
  }

  list(): readonly AgentInstance[] {
    this.assertTopology();
    const result: AgentInstance[] = [];
    const visited = new Set<AgentInstanceId>();
    const visit = (instance: AgentInstance) => {
      if (visited.has(instance.instanceId)) {
        throw new Error(`RuntimeTree duplicate node during traversal: ${instance.instanceId}`);
      }
      visited.add(instance.instanceId);
      result.push(instance);
      for (const childId of this.children.get(instance.instanceId) ?? []) {
        const child = this.instances.get(childId);
        if (!child) {
          throw new Error(`RuntimeTree children index has unknown child: ${childId}`);
        }
        visit(child);
      }
    };
    for (const rootId of this.children.get(null) ?? []) {
      const root = this.instances.get(rootId);
      if (!root) throw new Error(`RuntimeTree roots index has unknown child: ${rootId}`);
      visit(root);
    }
    if (visited.size !== this.instances.size) {
      throw new Error(
        `RuntimeTree unreachable nodes during traversal (${visited.size}/${this.instances.size})`,
      );
    }
    return result;
  }

  update(instanceId: AgentInstanceId, update: (instance: AgentInstance) => void): void {
    this.assertTopology();
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`RuntimeTree instance not found: ${instanceId}`);
    const previousSid = instance.sid;
    const previousInstanceId = instance.instanceId;
    const previousParentId = instance.parentInstanceId;
    try {
      update(instance);
      this.validateUpdatedInstance(instance, instanceId, previousParentId);
      if (instance.parentInstanceId !== previousParentId) {
        this.children.get(previousParentId)?.delete(instanceId);
        let siblings = this.children.get(instance.parentInstanceId);
        if (!siblings) {
          siblings = new Set();
          this.children.set(instance.parentInstanceId, siblings);
        }
        siblings.add(instanceId);
      }
      this.assertTopology();
    } catch (error) {
      if (instance.parentInstanceId !== previousParentId) {
        this.children.get(instance.parentInstanceId)?.delete(instanceId);
        let siblings = this.children.get(previousParentId);
        if (!siblings) {
          siblings = new Set();
          this.children.set(previousParentId, siblings);
        }
        siblings.add(instanceId);
        (instance as { parentInstanceId: AgentInstanceId | null }).parentInstanceId = previousParentId;
      }
      (instance as { sid: SessionId }).sid = previousSid;
      (instance as { instanceId: AgentInstanceId }).instanceId = previousInstanceId;
      throw error;
    }
    this.emit({ kind: "updated", instance });
  }

  touch(instanceId: AgentInstanceId): void {
    this.assertTopology();
    const instance = this.instances.get(instanceId);
    if (instance) this.emit({ kind: "updated", instance });
  }

  removeSubtree(instanceId: AgentInstanceId, reason?: string): readonly AgentInstance[] {
    this.assertTopology();
    if (!this.instances.has(instanceId)) return [];
    const removed: AgentInstance[] = [];
    const remove = (currentId: AgentInstanceId) => {
      for (const child of [...(this.children.get(currentId) ?? [])]) remove(child);
      const instance = this.instances.get(currentId);
      if (!instance) return;
      this.children.delete(currentId);
      this.children.get(instance.parentInstanceId)?.delete(currentId);
      this.instances.delete(currentId);
      removed.push(instance);
      this.emit({ kind: "removed", instance, ...(reason ? { reason } : {}) });
    };
    remove(instanceId);
    this.assertTopology();
    return removed;
  }

  /** Return a 1-based depth, failing closed if the parent chain is corrupt. */
  depthOf(instanceId: AgentInstanceId): number {
    this.assertTopology();
    const start = this.instances.get(instanceId);
    if (!start) throw new Error(`RuntimeTree instance not found: ${instanceId}`);
    let depth = 1;
    let current = start;
    const visited = new Set<AgentInstanceId>();
    while (current.parentInstanceId !== null) {
      if (visited.has(current.instanceId)) {
        throw new Error(`RuntimeTree cycle during depth traversal: ${current.instanceId}`);
      }
      visited.add(current.instanceId);
      const parent = this.instances.get(current.parentInstanceId);
      if (!parent) {
        throw new Error(`RuntimeTree parent not found during depth traversal: ${current.parentInstanceId}`);
      }
      depth += 1;
      current = parent;
    }
    return depth;
  }

  onChange(listener: (change: RuntimeTreeChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.instances.size;
  }

  private emit(change: RuntimeTreeChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private validateUpdatedInstance(
    instance: AgentInstance,
    instanceId: AgentInstanceId,
    previousParentId: AgentInstanceId | null,
  ): void {
    if (instance.sid !== this.sid) {
      throw new Error(`RuntimeTree session mismatch: ${instance.sid} !== ${this.sid}`);
    }
    if (instance.instanceId !== instanceId) {
      throw new Error(`RuntimeTree instanceId is immutable: ${instanceId}`);
    }
    const parentId = instance.parentInstanceId;
    if (parentId === instanceId) {
      throw new Error(`RuntimeTree self-parent cycle: ${instanceId}`);
    }
    if (parentId !== null && !this.instances.has(parentId)) {
      throw new Error(`RuntimeTree parent not found: ${parentId}`);
    }
    if (parentId !== previousParentId && parentId !== null) {
      let current = this.instances.get(parentId);
      const visited = new Set<AgentInstanceId>();
      while (current) {
        if (visited.has(current.instanceId)) {
          throw new Error(`RuntimeTree cycle while reparenting: ${current.instanceId}`);
        }
        visited.add(current.instanceId);
        if (current.instanceId === instanceId) {
          throw new Error(`RuntimeTree descendant parent cycle: ${instanceId} <- ${parentId}`);
        }
        current = current.parentInstanceId === null
          ? undefined
          : this.instances.get(current.parentInstanceId);
      }
    }
  }

  /** Validate both indexes and every parent chain before exposing topology. */
  private assertTopology(): void {
    for (const [instanceId, instance] of this.instances) {
      if (instance.sid !== this.sid) {
        throw new Error(`RuntimeTree session mismatch in topology: ${instanceId}`);
      }
      if (!this.children.has(instanceId)) {
        throw new Error(`RuntimeTree missing children index: ${instanceId}`);
      }
      const parentId = instance.parentInstanceId;
      if (parentId !== null && !this.instances.has(parentId)) {
        throw new Error(`RuntimeTree parent not found in topology: ${parentId}`);
      }
      if (!this.children.get(parentId)?.has(instanceId)) {
        throw new Error(`RuntimeTree parent index mismatch: ${instanceId}`);
      }

      const visited = new Set<AgentInstanceId>();
      let current: AgentInstance | undefined = instance;
      while (current.parentInstanceId !== null) {
        if (visited.has(current.instanceId)) {
          throw new Error(`RuntimeTree cycle in parent chain: ${current.instanceId}`);
        }
        visited.add(current.instanceId);
        current = this.instances.get(current.parentInstanceId);
        if (!current) {
          throw new Error(`RuntimeTree parent disappeared in parent chain: ${instanceId}`);
        }
      }
    }

    for (const [parentId, childIds] of this.children) {
      if (parentId !== null && !this.instances.has(parentId)) {
        throw new Error(`RuntimeTree children index has unknown parent: ${parentId}`);
      }
      for (const childId of childIds) {
        const child = this.instances.get(childId);
        if (!child) throw new Error(`RuntimeTree children index has unknown child: ${childId}`);
        if (child.parentInstanceId !== parentId) {
          throw new Error(`RuntimeTree child index mismatch: ${childId}`);
        }
      }
    }
  }
}
