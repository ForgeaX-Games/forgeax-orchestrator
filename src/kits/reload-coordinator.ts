/**
 * Session-scoped Kit source revision coordinator.
 *
 * It watches Kit authoring sources, but it never creates/removes Agent
 * instances and never watches agent definitions. A valid source change stages
 * a new AgentExecution revision. Idle instances may refresh their compatibility
 * Kit registries immediately; running instances apply the revision at the next
 * turn boundary.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FSWatcherAPI, PathManagerAPI, WatchRegistration } from "../fs/types";
import type { RuntimeAgentHost } from "../runtime/runtime-agent-host";
import type { AgentInstance } from "../runtime/types";
import { stableHash } from "../runtime/freeze";
import type { KitKind } from "./types";
import {
  computeFileHash,
  getDepsForFile,
  getEntryDeps,
  invalidateHash,
  shortHash,
} from "./resolve-hook";

const VALID_KINDS: ReadonlySet<KitKind> = new Set(["tools", "slots", "plugins"]);
const OWNER_PREFIX = "kit-source-revision";

interface ReloadTarget {
  readonly instance: AgentInstance;
  readonly agent: RuntimeAgentHost;
  readonly templateKitsDir?: string;
  readonly externalPackageDirs: readonly string[];
}

export class AgentKitReloadCoordinator {
  /** Capability refresh targets only; RuntimeTree remains lifecycle authority. */
  private readonly targets = new Map<string, ReloadTarget>();
  private readonly watchRegs: WatchRegistration[] = [];
  private readonly flushSnapshots = new Map<string, string>();
  private readonly primedKitDirs = new Set<string>();
  private readonly primedPackageDirs = new Set<string>();
  private sharedWatching = false;

  constructor(
    private readonly sid: string,
    private readonly fsWatcher: FSWatcherAPI,
    private readonly pm: PathManagerAPI,
    private readonly onRevision?: (
      instance: AgentInstance,
      revision: string,
      kinds: ReadonlySet<KitKind>,
    ) => void | Promise<void>,
  ) {}

  async registerAgent(
    instance: AgentInstance,
    agent: RuntimeAgentHost,
  ): Promise<void> {
    if (!this.sharedWatching) {
      this.startWatching();
      this.sharedWatching = true;
    }
    const templateRoot = instance.template.resources.templateRoot;
    const templateKitsDir = templateRoot ? join(templateRoot, "kits") : undefined;
    const externalPackageDirs = [...new Set(
      instance.execution.next().kits
        .flatMap((kit) =>
          kit.source.kind === "directory" ? [kit.source.path] : []
        )
        .filter((dir) =>
          !templateKitsDir || !isPathInside(templateKitsDir, dir)
        ),
    )];
    this.targets.set(instance.instanceId, {
      instance,
      agent,
      ...(templateKitsDir ? { templateKitsDir } : {}),
      externalPackageDirs,
    });
    if (templateKitsDir && existsSync(templateKitsDir)) {
      this.watchRegs.push(this.fsWatcher.watchDir(
        templateKitsDir,
        (event) => this.onTemplateKitFileChanged(instance.instanceId, templateKitsDir, event.path),
        {
          ownerId: `${OWNER_PREFIX}:${this.sid}:${instance.instanceId}`,
          debounceMs: 500,
        },
      ));
    }
    for (const packageDir of externalPackageDirs) {
      if (!existsSync(packageDir)) continue;
      const ownerId = this.packageOwner(instance.instanceId, packageDir);
      this.watchRegs.push(this.fsWatcher.watchDir(
        packageDir,
        (event) =>
          this.onTemplateKitFileChanged(
            instance.instanceId,
            packageDir,
            event.path,
            true,
          ),
        { ownerId, debounceMs: 500 },
      ));
    }
    // Establish the polling baseline before the first turn enters the Kernel.
    // Otherwise a missed fs.watch event caused by that first turn's own file
    // edits would look like an initial observation and could never be detected.
    await this.primeSnapshotsForTarget(instance.instanceId);
  }

  unregisterAgent(instanceId: string): void {
    const target = this.targets.get(instanceId);
    for (const packageDir of target?.externalPackageDirs ?? []) {
      this.fsWatcher.unregisterOwner(this.packageOwner(instanceId, packageDir));
    }
    this.fsWatcher.unregisterOwner(`${OWNER_PREFIX}:${this.sid}:${instanceId}`);
    this.targets.delete(instanceId);
  }

  startWatching(): void {
    const sharedDirs = this.sharedKitDirs();
    for (const dir of sharedDirs) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // A read-only source simply cannot participate in hot reload.
      }
      if (!existsSync(dir)) continue;
      this.watchRegs.push(this.fsWatcher.watchDir(
        dir,
        (event) => this.onSharedKitFileChanged(dir, event.path),
        { ownerId: `${OWNER_PREFIX}:${this.sid}:shared`, debounceMs: 500 },
      ));
    }
  }

  stopWatching(): void {
    for (const reg of this.watchRegs.splice(0)) reg.dispose();
    this.fsWatcher.unregisterOwner(`${OWNER_PREFIX}:${this.sid}:shared`);
    for (const [instanceId, target] of this.targets) {
      this.fsWatcher.unregisterOwner(`${OWNER_PREFIX}:${this.sid}:${instanceId}`);
      for (const packageDir of target.externalPackageDirs) {
        this.fsWatcher.unregisterOwner(this.packageOwner(instanceId, packageDir));
      }
    }
    this.targets.clear();
    this.flushSnapshots.clear();
    this.primedKitDirs.clear();
    this.primedPackageDirs.clear();
    this.sharedWatching = false;
  }

  /** Polling fallback called by KernelTurnExecutor at the end of every unified
   * Kernel turn, before AgentRuntimeController commits the turn boundary.
   * Only Kit sources participate; Agent definition scanning and restart
   * callbacks are intentionally absent. */
  async flushReloads(): Promise<boolean> {
    const toReload = new Map<string, Set<KitKind>>();
    const sharedTargets = [...this.targets.keys()];
    const kitSources = new Map<string, Set<string>>();
    const packageSources = new Map<string, Set<string>>();
    for (const dir of this.sharedKitDirs()) {
      kitSources.set(dir, new Set(sharedTargets));
    }
    for (const [instanceId, target] of this.targets) {
      if (target.templateKitsDir) {
        addSourceTarget(kitSources, target.templateKitsDir, instanceId);
      }
      for (const packageDir of target.externalPackageDirs) {
        addSourceTarget(packageSources, packageDir, instanceId);
      }
    }
    for (const [dir, instanceIds] of kitSources) {
      await this.scanKitDir(dir, [...instanceIds], toReload);
    }
    for (const [dir, instanceIds] of packageSources) {
      await this.scanPackageDir(dir, [...instanceIds], toReload);
    }
    if (toReload.size === 0) return false;
    await Promise.all(
      [...toReload].map(([instanceId, kinds]) =>
        this.stageAndMaybeApply(instanceId, kinds)
      ),
    );
    return true;
  }

  private async primeSnapshotsForTarget(instanceId: string): Promise<void> {
    const target = this.targets.get(instanceId);
    if (!target) return;
    const ignored = new Map<string, Set<KitKind>>();
    for (const dir of this.sharedKitDirs()) {
      if (this.primedKitDirs.has(dir)) continue;
      await this.scanKitDir(dir, [instanceId], ignored, true);
      this.primedKitDirs.add(dir);
    }
    if (target.templateKitsDir) {
      if (!this.primedKitDirs.has(target.templateKitsDir)) {
        await this.scanKitDir(
          target.templateKitsDir,
          [instanceId],
          ignored,
          true,
        );
        this.primedKitDirs.add(target.templateKitsDir);
      }
    }
    for (const packageDir of target.externalPackageDirs) {
      if (this.primedPackageDirs.has(packageDir)) continue;
      await this.scanPackageDir(packageDir, [instanceId], ignored, true);
      this.primedPackageDirs.add(packageDir);
    }
  }

  private sharedKitDirs(): string[] {
    return [
      this.pm.builtin().resourceDir("kits"),
      this.pm.user().resourceDir("kits"),
      this.pm.session(this.sid).resourceDir("kits"),
    ];
  }

  private onSharedKitFileChanged(root: string, subPath: string): void {
    const kinds = this.changedKinds(subPath, join(root, subPath));
    if (!kinds) return;
    for (const instanceId of this.targets.keys()) {
      this.scheduleReload(instanceId, kinds);
    }
  }

  private onTemplateKitFileChanged(
    instanceId: string,
    root: string,
    subPath: string,
    directPackage = false,
  ): void {
    const kinds = this.changedKinds(
      subPath,
      join(root, subPath),
      directPackage,
    );
    if (!kinds) return;
    this.scheduleReload(instanceId, kinds);
  }

  private scheduleReload(
    instanceId: string,
    kinds: ReadonlySet<KitKind>,
  ): void {
    void this.stageAndMaybeApply(instanceId, kinds).catch((error) => {
      process.stderr.write(
        `[kit-reload] ${this.sid}/${instanceId}: revision rejected, ` +
          `keeping last-known-good registry: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
      );
    });
  }

  private changedKinds(
    subPath: string,
    absPath: string,
    directPackage = false,
  ): Set<KitKind> | null {
    const parts = subPath.split(/[\\/]/);
    let direct: KitKind | "all" | null = null;
    if (
      (directPackage && parts.length === 1 && parts[0] === "condition.ts") ||
      (!directPackage && parts.length === 2 && parts[1] === "condition.ts")
    ) {
      direct = "all";
    } else if (
      ((directPackage && parts.length === 2) ||
        (!directPackage && parts.length === 3)) &&
      VALID_KINDS.has(parts[directPackage ? 0 : 1] as KitKind) &&
      parts[directPackage ? 1 : 2]!.endsWith(".ts")
    ) {
      direct = parts[directPackage ? 0 : 1] as KitKind;
    }
    invalidateHash(absPath);
    if (direct === "all") return new Set(VALID_KINDS);
    if (direct) return new Set([direct]);

    const dependents = getDepsForFile(absPath);
    if (dependents.size === 0) return null;
    const kinds = new Set<KitKind>();
    for (const entry of dependents) {
      const entryParts = entry.split(/[\\/]/);
      const candidate = entryParts.at(-2) as KitKind | undefined;
      if (candidate && VALID_KINDS.has(candidate)) kinds.add(candidate);
    }
    return kinds.size > 0 ? kinds : new Set(VALID_KINDS);
  }

  private async scanKitDir(
    kitDir: string,
    instanceIds: readonly string[],
    toReload: Map<string, Set<KitKind>>,
    baselineOnly = false,
  ): Promise<void> {
    let packages: import("node:fs").Dirent[];
    try {
      packages = await readdir(kitDir, { withFileTypes: true });
    } catch {
      if (existsSync(kitDir)) return;
      packages = [];
    }
    const observedKeys = new Set<string>();
    for (const pkg of packages) {
      if (!pkg.isDirectory()) continue;
      for (const kind of VALID_KINDS) {
        let files: string[];
        const kindDir = join(kitDir, pkg.name, kind);
        try {
          files = (await readdir(kindDir))
            .filter((file) => file.endsWith(".ts"));
        } catch {
          if (existsSync(kindDir)) return;
          continue;
        }
        for (const file of files) {
          const path = join(kitDir, pkg.name, kind, file);
          const combined = this.combinedHash(path, join(kitDir, pkg.name, "condition.ts"));
          const key = `${kitDir}:${relative(kitDir, path)}`;
          observedKeys.add(key);
          const previous = this.flushSnapshots.get(key);
          if (previous === undefined) {
            this.flushSnapshots.set(key, combined);
            if (!baselineOnly) {
              this.recordReloadKind(instanceIds, kind, toReload);
            }
            continue;
          }
          if (baselineOnly || previous === combined) continue;
          this.flushSnapshots.set(key, combined);
          this.recordReloadKind(instanceIds, kind, toReload);
        }
      }
    }
    if (!baselineOnly) {
      this.recordDeletedEntries(kitDir, observedKeys, instanceIds, toReload);
    }
  }

  private async scanPackageDir(
    packageDir: string,
    instanceIds: readonly string[],
    toReload: Map<string, Set<KitKind>>,
    baselineOnly = false,
  ): Promise<void> {
    const observedKeys = new Set<string>();
    for (const kind of VALID_KINDS) {
      let files: string[];
      const kindDir = join(packageDir, kind);
      try {
        files = (await readdir(kindDir))
          .filter((file) => file.endsWith(".ts"));
      } catch {
        if (existsSync(kindDir)) return;
        continue;
      }
      for (const file of files) {
        const path = join(packageDir, kind, file);
        const combined = this.combinedHash(
          path,
          join(packageDir, "condition.ts"),
        );
        const key = `${packageDir}:${relative(packageDir, path)}`;
        observedKeys.add(key);
        const previous = this.flushSnapshots.get(key);
        if (previous === undefined) {
          this.flushSnapshots.set(key, combined);
          if (!baselineOnly) {
            this.recordReloadKind(instanceIds, kind, toReload);
          }
          continue;
        }
        if (baselineOnly || previous === combined) continue;
        this.flushSnapshots.set(key, combined);
        this.recordReloadKind(instanceIds, kind, toReload);
      }
    }
    if (!baselineOnly) {
      this.recordDeletedEntries(
        packageDir,
        observedKeys,
        instanceIds,
        toReload,
      );
    }
  }

  private recordDeletedEntries(
    sourceDir: string,
    observedKeys: ReadonlySet<string>,
    instanceIds: readonly string[],
    toReload: Map<string, Set<KitKind>>,
  ): void {
    const prefix = `${sourceDir}:`;
    for (const key of [...this.flushSnapshots.keys()]) {
      if (!key.startsWith(prefix) || observedKeys.has(key)) continue;
      this.flushSnapshots.delete(key);
      const parts = key.slice(prefix.length).split(/[\\/]/);
      const kind = parts.at(-2) as KitKind | undefined;
      if (kind && VALID_KINDS.has(kind)) {
        this.recordReloadKind(instanceIds, kind, toReload);
      }
    }
  }

  private recordReloadKind(
    instanceIds: readonly string[],
    kind: KitKind,
    toReload: Map<string, Set<KitKind>>,
  ): void {
    for (const instanceId of instanceIds) {
      let kinds = toReload.get(instanceId);
      if (!kinds) {
        kinds = new Set();
        toReload.set(instanceId, kinds);
      }
      kinds.add(kind);
    }
  }

  private packageOwner(instanceId: string, packageDir: string): string {
    return `${OWNER_PREFIX}:${this.sid}:${instanceId}:${stableHash(packageDir)}`;
  }

  private combinedHash(path: string, conditionPath: string): string {
    invalidateHash(path);
    let combined = computeFileHash(path);
    const deps = [...getEntryDeps(path)].sort();
    if (deps.length) {
      combined = shortHash(
        combined + deps.map((dep) => {
          invalidateHash(dep);
          return computeFileHash(dep);
        }).join(""),
      );
    }
    invalidateHash(conditionPath);
    const conditionHash = computeFileHash(conditionPath);
    return conditionHash === "0"
      ? combined
      : shortHash(combined + conditionHash);
  }

  private async stageAndMaybeApply(
    instanceId: string,
    kinds: ReadonlySet<KitKind>,
  ): Promise<void> {
    const target = this.targets.get(instanceId);
    if (!target) return;
    const previous = target.instance.execution.next();
    const revision = `exec_${stableHash({
      previous: previous.revision,
      changedKinds: [...kinds].sort(),
      sourceHashes: [...this.flushSnapshots].sort(([a], [b]) => a.localeCompare(b)),
    })}`;
    await target.agent.validateKitKinds(kinds);
    await this.onRevision?.(target.instance, revision, kinds);
    target.instance.execution.stage(Object.freeze({
      ...previous,
      revision,
    }));

    // Running turns retain their pinned registry. KernelTurnExecutor observes
    // the staged revision and refreshes before executing the next turn.
    if (target.instance.state === "running") return;
    target.instance.execution.reconcileAtTurnBoundary();
    for (const kind of kinds) await target.agent.reloadKitKind(kind);
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function addSourceTarget(
  sources: Map<string, Set<string>>,
  sourceDir: string,
  instanceId: string,
): void {
  let instanceIds = sources.get(sourceDir);
  if (!instanceIds) {
    instanceIds = new Set();
    sources.set(sourceDir, instanceIds);
  }
  instanceIds.add(instanceId);
}
