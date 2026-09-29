/**
 * Executable NPC memory provider registry.
 *
 * The regular kit PluginRegistry is intentionally not used here.  A memory
 * provider has a narrower ABI, a source provenance boundary, and two
 * independent facets (Reader and command Writer).  In particular, this
 * registry never accepts an AgentContext and never resolves an entry by
 * importing a path supplied by a provider.
 *
 * The host supplies an allowlisted source and a loader.  The loader receives
 * only the already-allowlisted source record; it is the host's responsibility
 * to map that record to its trusted module artifact.  An untrusted source is
 * rejected before the loader is called.
 */

import {
  parseNpcMemoryProviderManifestV1,
  validateNpcMemoryProviderFacetsV1,
  validateNpcMemoryProviderFactoryV1,
  type NpcMemoryCommandWriterHostV1,
  type NpcMemoryCommandWriterV1,
  type NpcMemoryProviderDescriptorV1,
  type NpcMemoryProviderManifestV1,
  type NpcMemoryReaderHostV1,
  type NpcMemoryReaderV1,
  type NpcMemoryCapability,
} from '@forgeax/types/npc-memory';

/** Runtime authority context supplied by the host, not read from provider code. */
export type NpcMemoryProviderAuthority =
  | 'asiw'
  | 'forgeax-file'
  | 'reference-fixture';

export type NpcMemoryProviderRegistryErrorCode =
  | 'source_not_trusted'
  | 'manifest_invalid'
  | 'abi_mismatch'
  | 'source_mismatch'
  | 'config_invalid'
  | 'export_missing'
  | 'factory_invalid'
  | 'capability_mismatch'
  | 'reader_policy_denied'
  | 'writer_policy_denied'
  | 'duplicate_provider'
  | 'provider_not_found'
  | 'lifecycle_failed'
  | 'reload_failed';

export interface NpcMemoryProviderRegistryError {
  readonly code: NpcMemoryProviderRegistryErrorCode;
  readonly message: string;
  readonly providerId?: string;
  readonly sourceId?: string;
  readonly facet?: 'reader' | 'writer';
  readonly cause?: unknown;
}

/**
 * A trusted source is an opaque host-owned reference.  `entry` is compared
 * byte-for-byte with the manifest; it is never resolved or normalized by the
 * registry.  `providerId` prevents one trusted artifact from being relabeled
 * as another provider.
 */
export interface NpcMemoryProviderTrustedSourceV1 {
  readonly sourceId: string;
  readonly providerId: string;
  readonly entry: string;
  /** Host-issued provenance; candidates cannot relabel a trusted artifact. */
  readonly authority: NpcMemoryProviderAuthority;
}

export interface NpcMemoryProviderCandidateV1 {
  /** Key into `sourceAllowlist`; not a path. */
  readonly sourceId: string;
  /** Untrusted until parsed by the F1 runtime schema. */
  readonly manifest: unknown;
  readonly config: unknown;
  /** Required even when the manifest has no configSchema. */
  readonly validateConfig: (config: unknown) => unknown;
}

export interface NpcMemoryProviderLoaderV1 {
  /**
   * Resolve one of the pre-approved source records.  Implementations may use
   * an import map, a package resolver, or an artifact cache; this registry
   * deliberately has no dynamic import/path execution capability of its own.
   */
  readonly load: (source: NpcMemoryProviderTrustedSourceV1) => Promise<unknown>;
}

export type NpcMemoryProviderPolicyResult = boolean | { readonly allow: boolean; readonly reason?: string };

export interface NpcMemoryProviderRegistryOptionsV1 {
  readonly sourceAllowlist: readonly NpcMemoryProviderTrustedSourceV1[];
  readonly loader: NpcMemoryProviderLoaderV1;
  readonly readerHost: NpcMemoryReaderHostV1;
  readonly writerHost?: NpcMemoryCommandWriterHostV1;
  /** Reader policy does not depend on writer policy.  Default: allow. */
  readonly readerPolicy?: (input: {
    readonly manifest: NpcMemoryProviderManifestV1;
    readonly authority: NpcMemoryProviderAuthority;
  }) => NpcMemoryProviderPolicyResult;
  /** Default: deny.  `authority=asiw` is always denied regardless of this hook. */
  readonly writerPolicy?: (input: {
    readonly manifest: NpcMemoryProviderManifestV1;
    readonly authority: NpcMemoryProviderAuthority;
  }) => NpcMemoryProviderPolicyResult;
}

export type NpcMemoryProviderLifecycleState =
  | 'registered'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface NpcMemoryProviderInstanceV1 {
  readonly providerId: string;
  readonly source: NpcMemoryProviderTrustedSourceV1;
  readonly manifest: NpcMemoryProviderManifestV1;
  readonly authority: NpcMemoryProviderAuthority;
  readonly reader: NpcMemoryReaderV1;
  /** Undefined when no writer was declared or policy denied it. */
  readonly writer?: NpcMemoryCommandWriterV1;
  readonly writerPolicy: 'enabled' | 'denied' | 'not-declared';
  readonly config: unknown;
}

export interface NpcMemoryProviderStatusV1 {
  readonly providerId: string;
  readonly state: NpcMemoryProviderLifecycleState;
  readonly writerPolicy: NpcMemoryProviderInstanceV1['writerPolicy'];
  readonly errors: readonly NpcMemoryProviderRegistryError[];
  readonly warnings: readonly NpcMemoryProviderRegistryError[];
}

export type NpcMemoryProviderRegistryResult<T = undefined> =
  | { readonly ok: true; readonly value: T; readonly warnings?: readonly NpcMemoryProviderRegistryError[] }
  | { readonly ok: false; readonly error: NpcMemoryProviderRegistryError };

export interface NpcMemoryProviderBootReportV1 {
  readonly results: readonly NpcMemoryProviderRegistryResult<{ readonly providerId: string }>[];
  readonly loadedProviderIds: readonly string[];
}

interface RuntimeRecord {
  readonly instance: NpcMemoryProviderInstanceV1;
  /** Validated host-owned registration input used only to construct a fresh
   * rollback instance; never exposed to provider code or public status. */
  readonly rollbackCandidate: NpcMemoryProviderCandidateV1;
  state: NpcMemoryProviderLifecycleState;
  errors: NpcMemoryProviderRegistryError[];
  warnings: NpcMemoryProviderRegistryError[];
  readerStartAttempted: boolean;
  readerStarted: boolean;
  readerStopCalled: boolean;
  writerStartAttempted: boolean;
  writerStarted: boolean;
  writerStopCalled: boolean;
  transition?: Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>>;
}

const COMMAND_WRITER_CAPABILITIES = new Set<NpcMemoryCapability>([
  'external-commit',
  'settle',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function error(
  code: NpcMemoryProviderRegistryErrorCode,
  message: string,
  fields: Omit<NpcMemoryProviderRegistryError, 'code' | 'message'> = {},
): NpcMemoryProviderRegistryError {
  // Provider/loader exceptions may contain local paths, credentials, or stack
  // details. Registry results and status are safe-to-surface diagnostics, so
  // retain only the stable public fields here; hosts may log raw exceptions at
  // their injection boundary if their audit policy permits it.
  const { cause: _privateCause, ...publicFields } = fields;
  return { code, message, ...publicFields };
}

function describeThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function hasCapability(
  descriptor: NpcMemoryProviderDescriptorV1,
  capability: NpcMemoryCapability,
): boolean {
  return descriptor.capabilities.includes(capability);
}

function hasCommandWriterCapability(descriptor: NpcMemoryProviderDescriptorV1): boolean {
  return descriptor.capabilities.some((capability) => COMMAND_WRITER_CAPABILITIES.has(capability));
}

function policyAllows(result: NpcMemoryProviderPolicyResult | undefined, defaultValue: boolean): boolean {
  if (result === undefined) return defaultValue;
  return typeof result === 'boolean' ? result : result.allow;
}

function readerFacetLooksValid(
  factory: Record<string, unknown>,
  reader: unknown,
  descriptorHasWriter: boolean,
): boolean {
  if (!descriptorHasWriter) {
    return validateNpcMemoryProviderFacetsV1(factory, reader, undefined);
  }

  // F1's shared validator intentionally checks Reader and Writer together when
  // writer capabilities are declared.  A host may deny the Writer facet while
  // still accepting the independent Reader.  Validate the Reader shape with a
  // side-effect-free descriptor-shaped sentinel; the actual writer factory is
  // never called in this branch.
  const blockedWriter = {
    descriptor: factory.descriptor,
    start: async () => undefined,
    stop: async () => undefined,
    ...(hasCapability(factory.descriptor as NpcMemoryProviderDescriptorV1, 'external-commit')
      ? { commit: async () => ({ commandId: 'blocked', status: 'unsupported' as const }) }
      : {}),
    ...(hasCapability(factory.descriptor as NpcMemoryProviderDescriptorV1, 'settle')
      ? { settle: async () => ({ commandId: 'blocked', status: 'unsupported' as const }) }
      : {}),
  };
  return validateNpcMemoryProviderFacetsV1(factory, reader, blockedWriter);
}

/**
 * Registry for executable NPC memory providers.
 *
 * `register` prepares an instance but does not start it.  `boot` is the safe
 * bulk operation (one bad candidate is reported while other candidates still
 * get a chance to load); `activate` performs register + start.  All methods
 * return typed results so a caller cannot mistake a skipped provider for a
 * successful fallback.
 */
export class NpcMemoryProviderRegistry {
  readonly #sourceById = new Map<string, NpcMemoryProviderTrustedSourceV1>();
  readonly #records = new Map<string, RuntimeRecord>();
  readonly #operationGates = new Map<string, Promise<void>>();
  readonly #options: NpcMemoryProviderRegistryOptionsV1;

  constructor(options: NpcMemoryProviderRegistryOptionsV1) {
    this.#options = options;
    if (!options.loader || typeof options.loader.load !== 'function') {
      throw new TypeError('NpcMemoryProviderRegistry requires a host-injected loader');
    }
    if (!options.readerHost
      || typeof options.readerHost.now !== 'function'
      || typeof options.readerHost.monotonicNow !== 'function'
      || typeof options.readerHost.resolveIdentity !== 'function'
      || typeof options.readerHost.identityResolverVersion !== 'function'
      || typeof options.readerHost.audit !== 'function') {
      throw new TypeError('NpcMemoryProviderRegistry requires a complete reader host');
    }
    if (options.writerHost && (typeof options.writerHost.now !== 'function'
      || typeof options.writerHost.audit !== 'function')) {
      throw new TypeError('NpcMemoryProviderRegistry writer host is invalid');
    }
    const sourceIds = new Set<string>();
    const authorityByProvider = new Map<string, NpcMemoryProviderAuthority>();
    for (const source of options.sourceAllowlist) {
      if (!source || !source.sourceId || !source.providerId || !source.entry
        || !['asiw', 'forgeax-file', 'reference-fixture'].includes(source.authority)) {
        throw new TypeError('NpcMemoryProviderRegistry source allowlist contains an invalid entry');
      }
      if (sourceIds.has(source.sourceId)) {
        throw new TypeError(`NpcMemoryProviderRegistry source allowlist collision: ${source.sourceId}`);
      }
      const existingAuthority = authorityByProvider.get(source.providerId);
      if (existingAuthority !== undefined && existingAuthority !== source.authority) {
        throw new TypeError(`NpcMemoryProviderRegistry provider authority collision: ${source.providerId}`);
      }
      sourceIds.add(source.sourceId);
      authorityByProvider.set(source.providerId, source.authority);
      this.#sourceById.set(source.sourceId, Object.freeze({ ...source }));
    }
  }

  async #withProviderLock<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationGates.get(providerId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#operationGates.set(providerId, gate);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#operationGates.get(providerId) === gate) this.#operationGates.delete(providerId);
    }
  }

  get(providerId: string): NpcMemoryProviderInstanceV1 | undefined {
    return this.#records.get(providerId)?.instance;
  }

  status(providerId: string): NpcMemoryProviderStatusV1 | undefined {
    const record = this.#records.get(providerId);
    if (!record) return undefined;
    return {
      providerId,
      state: record.state,
      writerPolicy: record.instance.writerPolicy,
      errors: [...record.errors],
      warnings: [...record.warnings],
    };
  }

  statuses(): readonly NpcMemoryProviderStatusV1[] {
    return [...this.#records.keys()]
      .sort()
      .map((providerId) => this.status(providerId)!)
      .filter(Boolean);
  }

  /** Prepare one provider; source allowlist and all runtime contracts run first. */
  async register(
    candidate: NpcMemoryProviderCandidateV1,
  ): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    const source = this.#sourceById.get(candidate?.sourceId);
    if (!source) return this.#registerInternal(candidate, false);
    return this.#withProviderLock(source.providerId, () => this.#registerInternal(candidate, false));
  }

  async #registerInternal(
    candidate: NpcMemoryProviderCandidateV1,
    replaceExisting: boolean,
    prepared?: { record?: RuntimeRecord },
  ): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    const source = this.#sourceById.get(candidate?.sourceId);
    if (!source) {
      return { ok: false, error: error('source_not_trusted', `provider source is not allowlisted: ${candidate?.sourceId ?? '<missing>'}`, { sourceId: candidate?.sourceId }) };
    }

    let manifest: NpcMemoryProviderManifestV1;
    try {
      manifest = parseNpcMemoryProviderManifestV1(candidate.manifest);
    } catch (cause) {
      const rawAbi = isRecord(candidate.manifest) ? candidate.manifest.abiVersion : undefined;
      return {
        ok: false,
        error: error(
          rawAbi !== 1 ? 'abi_mismatch' : 'manifest_invalid',
          rawAbi !== 1 ? 'provider manifest ABI version is not supported' : `provider manifest is invalid: ${describeThrown(cause)}`,
          { sourceId: source.sourceId, cause },
        ),
      };
    }

    if (manifest.id !== source.providerId || manifest.entry !== source.entry) {
      return {
        ok: false,
        error: error(
          manifest.id !== source.providerId ? 'source_mismatch' : 'source_not_trusted',
          manifest.id !== source.providerId
            ? `manifest provider id ${manifest.id} does not match trusted source ${source.providerId}`
            : `manifest entry does not match trusted source ${source.entry}`,
          { providerId: manifest.id, sourceId: source.sourceId },
        ),
      };
    }

    if (this.#records.has(manifest.id) && !replaceExisting) {
      return { ok: false, error: error('duplicate_provider', `provider is already registered: ${manifest.id}`, { providerId: manifest.id, sourceId: source.sourceId }) };
    }

    if (typeof candidate.validateConfig !== 'function') {
      return { ok: false, error: error('config_invalid', 'provider registration requires an explicit config validator', { providerId: manifest.id, sourceId: source.sourceId }) };
    }

    let config = candidate.config;
    try {
      const validated = candidate.validateConfig(candidate.config);
      if (validated !== undefined) config = validated;
    } catch (cause) {
      return { ok: false, error: error('config_invalid', `provider config is invalid: ${describeThrown(cause)}`, { providerId: manifest.id, sourceId: source.sourceId, cause }) };
    }

    let readerAllowed = true;
    try {
      readerAllowed = policyAllows(
        this.#options.readerPolicy?.({ manifest, authority: source.authority }),
        true,
      );
    } catch (cause) {
      return { ok: false, error: error('reader_policy_denied', `reader policy failed: ${describeThrown(cause)}`, { providerId: manifest.id, sourceId: source.sourceId, facet: 'reader', cause }) };
    }
    if (!readerAllowed) {
      return { ok: false, error: error('reader_policy_denied', `reader policy denied provider ${manifest.id}`, { providerId: manifest.id, sourceId: source.sourceId, facet: 'reader' }) };
    }

    // Complete the non-executable capability/host preflight before loading any
    // provider module.  This both keeps the permission boundary explicit and
    // prevents a module that cannot be hosted from running initialization code.
    const descriptor = manifest.descriptor;
    const snapshotCapability = hasCapability(descriptor, 'snapshot-read');
    const referenceCapability = hasCapability(descriptor, 'reference-fixture-read');
    const commandWriterCapability = hasCommandWriterCapability(descriptor);
    const writerDeclared = descriptor.roles.includes('writer');
    const requestedPermissions = new Set(manifest.requestedPermissions);
    const expectedNetwork = snapshotCapability ? 'network:snapshot-read' : undefined;
    const expectedFixture = referenceCapability ? 'fixture:reference-read' : undefined;
    if ((expectedNetwork !== undefined) !== requestedPermissions.has('network:snapshot-read')
      || (expectedFixture !== undefined) !== requestedPermissions.has('fixture:reference-read')) {
      return { ok: false, error: error('capability_mismatch', 'provider source capability and permission do not match', { providerId: manifest.id, sourceId: source.sourceId }) };
    }
    if (referenceCapability !== (source.authority === 'reference-fixture')) {
      return { ok: false, error: error('source_mismatch', 'reference fixture capability must use a reference-fixture trusted source', { providerId: manifest.id, sourceId: source.sourceId }) };
    }
    // `fs:provider-state` is a writer-side permission.  It may be omitted for
    // a remote writer, but a reader-only provider cannot request it.
    if (requestedPermissions.has('fs:provider-state') && !writerDeclared) {
      return { ok: false, error: error('capability_mismatch', 'reader-only provider cannot request provider-state filesystem permission', { providerId: manifest.id, sourceId: source.sourceId }) };
    }
    if (snapshotCapability && typeof this.#options.readerHost.readSnapshot !== 'function') {
      return { ok: false, error: error('capability_mismatch', 'snapshot-read requires a host readSnapshot method', { providerId: manifest.id, sourceId: source.sourceId, facet: 'reader' }) };
    }
    if (referenceCapability && typeof this.#options.readerHost.readReferenceFixture !== 'function') {
      return { ok: false, error: error('capability_mismatch', 'reference-fixture-read requires a host readReferenceFixture method', { providerId: manifest.id, sourceId: source.sourceId, facet: 'reader' }) };
    }

    let moduleValue: unknown;
    try {
      // This is the first and only point at which the host loader is called,
      // after source id, provider id, and exact entry checks have passed.
      moduleValue = await this.#options.loader.load(source);
    } catch (cause) {
      return { ok: false, error: error('factory_invalid', `provider module failed to load: ${describeThrown(cause)}`, { providerId: manifest.id, sourceId: source.sourceId, cause }) };
    }

    if (!isRecord(moduleValue) || !Object.prototype.hasOwnProperty.call(moduleValue, manifest.exportName)) {
      return { ok: false, error: error('export_missing', `provider export is missing: ${manifest.exportName}`, { providerId: manifest.id, sourceId: source.sourceId }) };
    }
    const factory = moduleValue[manifest.exportName];
    if (!validateNpcMemoryProviderFactoryV1(manifest, factory)) {
      return { ok: false, error: error('factory_invalid', `provider export does not implement the memory factory ABI: ${manifest.id}`, { providerId: manifest.id, sourceId: source.sourceId }) };
    }

    const scopedReaderHost: NpcMemoryReaderHostV1 = Object.freeze({
      now: () => this.#options.readerHost.now(),
      monotonicNow: () => this.#options.readerHost.monotonicNow(),
      resolveIdentity: (request: Parameters<NpcMemoryReaderHostV1['resolveIdentity']>[0]) => this.#options.readerHost.resolveIdentity(request),
      identityResolverVersion: (scope: Parameters<NpcMemoryReaderHostV1['identityResolverVersion']>[0]) => this.#options.readerHost.identityResolverVersion(scope),
      audit: (event: Parameters<NpcMemoryReaderHostV1['audit']>[0]) => this.#options.readerHost.audit(event),
      ...(snapshotCapability ? {
        readSnapshot: (
          subject: Parameters<NonNullable<NpcMemoryReaderHostV1['readSnapshot']>>[0],
          input: Parameters<NonNullable<NpcMemoryReaderHostV1['readSnapshot']>>[1],
        ) => this.#options.readerHost.readSnapshot!(subject, input),
      } : {}),
      ...(referenceCapability ? {
        readReferenceFixture: (
          scope: Parameters<NonNullable<NpcMemoryReaderHostV1['readReferenceFixture']>>[0],
          input: Parameters<NonNullable<NpcMemoryReaderHostV1['readReferenceFixture']>>[1],
        ) => this.#options.readerHost.readReferenceFixture!(scope, input),
      } : {}),
    });

    let reader: unknown;
    try {
      reader = (factory as { createReader: (host: NpcMemoryReaderHostV1, config: unknown) => unknown }).createReader(scopedReaderHost, config);
    } catch (cause) {
      return { ok: false, error: error('factory_invalid', `reader factory threw: ${describeThrown(cause)}`, { providerId: manifest.id, sourceId: source.sourceId, facet: 'reader', cause }) };
    }
    if (!readerFacetLooksValid(factory as unknown as Record<string, unknown>, reader, commandWriterCapability)) {
      return { ok: false, error: error('factory_invalid', 'reader facet does not match the provider ABI/descriptor', { providerId: manifest.id, sourceId: source.sourceId, facet: 'reader' }) };
    }

    let writer: NpcMemoryCommandWriterV1 | undefined;
    let writerPolicy: NpcMemoryProviderInstanceV1['writerPolicy'] = writerDeclared ? 'denied' : 'not-declared';
    const warnings: NpcMemoryProviderRegistryError[] = [];
    if (writerDeclared) {
      const unsupportedLifecycle = !commandWriterCapability;
      const forcedDeny = source.authority === 'asiw' || unsupportedLifecycle;
      let allowed = false;
      let policyFailure: unknown;
      if (!forcedDeny) {
        try {
          allowed = policyAllows(
            this.#options.writerPolicy?.({ manifest, authority: source.authority }),
            false,
          );
        } catch (cause) {
          policyFailure = cause;
        }
      }
      if (!allowed) {
        warnings.push(error('writer_policy_denied', forcedDeny
          ? source.authority === 'asiw'
            ? `authority ${source.authority} has a fixed writer deny policy`
            : 'provider declares no command-writer capability supported by this registry'
          : policyFailure === undefined
            ? `writer policy denied provider ${manifest.id}`
            : `writer policy failed: ${describeThrown(policyFailure)}`, { providerId: manifest.id, sourceId: source.sourceId, facet: 'writer', ...(policyFailure === undefined ? {} : { cause: policyFailure }) }));
      } else if (!this.#options.writerHost) {
        return { ok: false, error: error('capability_mismatch', 'writer facet requires a host writer capability', { providerId: manifest.id, sourceId: source.sourceId, facet: 'writer' }) };
      } else {
        const scopedWriterHost: NpcMemoryCommandWriterHostV1 = Object.freeze({
          now: () => this.#options.writerHost!.now(),
          audit: (event: Parameters<NpcMemoryCommandWriterHostV1['audit']>[0]) => this.#options.writerHost!.audit(event),
        });
        try {
          writer = (factory as { createCommandWriter: (host: NpcMemoryCommandWriterHostV1, config: unknown) => NpcMemoryCommandWriterV1 }).createCommandWriter(scopedWriterHost, config);
        } catch (cause) {
          return { ok: false, error: error('factory_invalid', `writer factory threw: ${describeThrown(cause)}`, { providerId: manifest.id, sourceId: source.sourceId, facet: 'writer', cause }) };
        }
        if (!validateNpcMemoryProviderFacetsV1(factory, reader, writer)) {
          return { ok: false, error: error('factory_invalid', 'writer facet does not match the provider ABI/descriptor', { providerId: manifest.id, sourceId: source.sourceId, facet: 'writer' }) };
        }
        writerPolicy = 'enabled';
      }
    }

    const instance: NpcMemoryProviderInstanceV1 = Object.freeze({
      providerId: manifest.id,
      source,
      manifest,
      authority: source.authority,
      reader: reader as NpcMemoryReaderV1,
      ...(writer === undefined ? {} : { writer }),
      writerPolicy,
      config,
    });
    const record: RuntimeRecord = {
      instance,
      rollbackCandidate: Object.freeze({
        sourceId: source.sourceId,
        manifest,
        config,
        validateConfig: candidate.validateConfig,
      }),
      state: 'registered',
      errors: [],
      warnings,
      readerStartAttempted: false,
      readerStarted: false,
      readerStopCalled: false,
      writerStartAttempted: false,
      writerStarted: false,
      writerStopCalled: false,
    };
    if (prepared) prepared.record = record;
    else this.#records.set(manifest.id, record);
    return { ok: true, value: { providerId: manifest.id }, ...(warnings.length ? { warnings } : {}) };
  }

  async activate(
    candidate: NpcMemoryProviderCandidateV1,
  ): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    const source = this.#sourceById.get(candidate?.sourceId);
    if (!source) return this.#registerInternal(candidate, false);
    return this.#withProviderLock(source.providerId, async () => {
      const registered = await this.#registerInternal(candidate, false);
      if (!registered.ok) return registered;
      const started = await this.#startInternal(registered.value.providerId);
      if (!started.ok) return started;
      if (registered.warnings?.length) return { ...started, warnings: registered.warnings };
      return started;
    });
  }

  async boot(
    candidates: readonly NpcMemoryProviderCandidateV1[],
  ): Promise<NpcMemoryProviderBootReportV1> {
    const results: NpcMemoryProviderRegistryResult<{ readonly providerId: string }>[] = [];
    for (const candidate of candidates) {
      results.push(await this.activate(candidate));
    }
    return {
      results,
      loadedProviderIds: this.statuses().filter((status) => status.state === 'running').map((status) => status.providerId),
    };
  }

  async start(providerId: string): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    return this.#withProviderLock(providerId, () => this.#startInternal(providerId));
  }

  async #startInternal(providerId: string): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    const record = this.#records.get(providerId);
    if (!record) return { ok: false, error: error('provider_not_found', `provider is not registered: ${providerId}`, { providerId }) };
    if (record.transition) return record.transition;
    if (record.state === 'running') return { ok: true, value: { providerId } };
    if (record.state !== 'registered') {
      return { ok: false, error: error('lifecycle_failed', `provider cannot start from state ${record.state}`, { providerId }) };
    }

    const transition = this.#startRecord(record);
    record.transition = transition;
    try {
      return await transition;
    } finally {
      if (record.transition === transition) record.transition = undefined;
    }
  }

  async stop(
    providerId: string,
    mode: 'drain' | 'abort' = 'abort',
  ): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    return this.#withProviderLock(providerId, () => this.#stopInternal(providerId, mode));
  }

  async #stopInternal(
    providerId: string,
    mode: 'drain' | 'abort',
  ): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    const record = this.#records.get(providerId);
    if (!record) return { ok: false, error: error('provider_not_found', `provider is not registered: ${providerId}`, { providerId }) };
    if (record.transition) await record.transition;
    if (record.state === 'stopped') return { ok: true, value: { providerId } };
    if (record.state === 'registered') {
      record.state = 'stopped';
      return { ok: true, value: { providerId } };
    }
    // A failed stop attempt does not prove the facet is gone. Explicit stop is
    // the supervisor's cleanup retry path; successful facets are skipped by
    // their stop-complete flags while failed facets are attempted again.

    record.state = 'stopping';
    const failures: NpcMemoryProviderRegistryError[] = [];
    await this.#stopWriter(record, mode, failures);
    await this.#stopReader(record, mode, failures);
    if (failures.length) {
      record.errors.push(...failures);
      record.state = 'failed';
      return { ok: false, error: failures[0]! };
    }
    record.state = 'stopped';
    return { ok: true, value: { providerId } };
  }

  /**
   * Replace only across a verified shutdown boundary. Provider facets may own
   * background work, so keeping the old instance in the map while starting a
   * replacement can still create two live providers. Preparation is detached,
   * then the old instance is stopped before the replacement starts.
   *
   * This deliberately trades hot-reload availability for a truthful
   * no-double-active invariant. If old stop fails it remains the visible
   * failed record and the replacement is never started. If replacement start
   * fails after old shutdown, the failed replacement becomes visible so a
   * supervisor has an inspectable owner to tear down.
   */
  async reload(
    providerId: string,
    candidate: NpcMemoryProviderCandidateV1,
  ): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    return this.#withProviderLock(providerId, () => this.#reloadInternal(providerId, candidate));
  }

  async #reloadInternal(
    providerId: string,
    candidate: NpcMemoryProviderCandidateV1,
  ): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    const previous = this.#records.get(providerId);
    if (!previous) return { ok: false, error: error('provider_not_found', `provider is not registered: ${providerId}`, { providerId }) };
    if (previous.transition) await previous.transition;
    const source = this.#sourceById.get(candidate?.sourceId);
    if (!source || source.providerId !== providerId) {
      return { ok: false, error: error('reload_failed', 'replacement trusted source does not match reload target', { providerId, sourceId: candidate?.sourceId }) };
    }
    const holder: { record?: RuntimeRecord } = {};
    const prepared = await this.#registerInternal(candidate, true, holder);
    if (!prepared.ok) return { ok: false, error: error('reload_failed', `replacement preparation failed: ${prepared.error.message}`, { providerId, cause: prepared.error }) };
    if (prepared.value.providerId !== providerId) {
      return { ok: false, error: error('reload_failed', `replacement provider id ${prepared.value.providerId} does not match reload target ${providerId}`, { providerId }) };
    }
    const replacement = holder.record;
    // `register` uses the manifest id as the map key.  A different id must not
    // be allowed to replace the requested provider.
    if (!replacement || replacement === previous || replacement.instance.providerId !== providerId) {
      if (replacement && replacement !== previous) await this.#stopRecord(replacement, 'abort');
      return { ok: false, error: error('reload_failed', 'replacement provider id does not match reload target', { providerId }) };
    }
    const stopped = await this.#stopRecord(previous, 'abort');
    if (!stopped.ok) {
      return { ok: false, error: error('reload_failed', `previous provider could not stop: ${stopped.error.message}`, { providerId, cause: stopped.error }) };
    }
    const started = await this.#startRecord(replacement);
    if (!started.ok) {
      // A failed start first stops every attempted facet. Only when that
      // cleanup is proven clean may we construct a fresh old-version instance
      // for rollback. Retrying the stopped `previous` record would violate
      // facet lifecycle contracts, so rollback always goes through the
      // host-owned validated candidate.
      const replacementCleanupFailed = replacement.errors.some((entry) => entry.facet !== undefined);
      if (replacementCleanupFailed) {
        this.#records.set(providerId, replacement);
        return { ok: false, error: error('reload_failed', `replacement start failed and cleanup was incomplete: ${started.error.message}`, { providerId, cause: started.error }) };
      }
      const rollbackHolder: { record?: RuntimeRecord } = {};
      const rollbackPrepared = await this.#registerInternal(previous.rollbackCandidate, true, rollbackHolder);
      if (!rollbackPrepared.ok || !rollbackHolder.record) {
        previous.errors.push(error('reload_failed', `replacement start failed and old-version rollback could not be prepared: ${rollbackPrepared.ok ? 'missing rollback record' : rollbackPrepared.error.message}`, { providerId, cause: rollbackPrepared.ok ? undefined : rollbackPrepared.error }));
        previous.state = 'failed';
        this.#records.set(providerId, previous);
        return { ok: false, error: error('reload_failed', `replacement start failed and old-version rollback could not be prepared: ${started.error.message}`, { providerId, cause: started.error }) };
      }
      const rollback = rollbackHolder.record;
      const rollbackStarted = await this.#startRecord(rollback);
      if (!rollbackStarted.ok) {
        this.#records.set(providerId, rollback);
        return { ok: false, error: error('reload_failed', `replacement start failed and old-version rollback could not start: ${rollbackStarted.error.message}`, { providerId, cause: rollbackStarted.error }) };
      }
      this.#records.set(providerId, rollback);
      return { ok: false, error: error('reload_failed', `replacement start failed: ${started.error.message}`, { providerId, cause: started.error }) };
    }
    this.#records.set(providerId, replacement);
    return { ok: true, value: { providerId }, ...(prepared.warnings?.length ? { warnings: prepared.warnings } : {}) };
  }

  async #startRecord(record: RuntimeRecord): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    const providerId = record.instance.providerId;
    record.state = 'starting';
    try {
      record.readerStartAttempted = true;
      await record.instance.reader.start();
      record.readerStarted = true;
      if (record.instance.writer) {
        record.writerStartAttempted = true;
        await record.instance.writer.start();
        record.writerStarted = true;
      }
      record.state = 'running';
      return { ok: true, value: { providerId } };
    } catch (cause) {
      const failures: NpcMemoryProviderRegistryError[] = [error('lifecycle_failed', `provider start failed: ${describeThrown(cause)}`, { providerId, cause })];
      await this.#stopWriter(record, 'abort', failures);
      await this.#stopReader(record, 'abort', failures);
      record.errors.push(...failures);
      record.state = 'failed';
      return { ok: false, error: failures[0]! };
    }
  }

  async #stopRecord(
    record: RuntimeRecord,
    mode: 'drain' | 'abort',
  ): Promise<NpcMemoryProviderRegistryResult<{ readonly providerId: string }>> {
    if (record.transition) await record.transition;
    if (record.state === 'stopped') return { ok: true, value: { providerId: record.instance.providerId } };
    record.state = 'stopping';
    const failures: NpcMemoryProviderRegistryError[] = [];
    await this.#stopWriter(record, mode, failures);
    await this.#stopReader(record, mode, failures);
    if (failures.length) {
      record.errors.push(...failures);
      record.state = 'failed';
      return { ok: false, error: failures[0]! };
    }
    record.state = 'stopped';
    return { ok: true, value: { providerId: record.instance.providerId } };
  }

  async #stopWriter(record: RuntimeRecord, mode: 'drain' | 'abort', failures: NpcMemoryProviderRegistryError[]): Promise<void> {
    const writer = record.instance.writer;
    if (!writer || !record.writerStartAttempted || record.writerStopCalled) return;
    try {
      await writer.stop({ mode });
      record.writerStopCalled = true;
    } catch (cause) {
      failures.push(error('lifecycle_failed', `writer stop failed: ${describeThrown(cause)}`, { providerId: record.instance.providerId, facet: 'writer', cause }));
    }
  }

  async #stopReader(record: RuntimeRecord, mode: 'drain' | 'abort', failures: NpcMemoryProviderRegistryError[]): Promise<void> {
    if (!record.readerStartAttempted || record.readerStopCalled) return;
    try {
      await record.instance.reader.stop({ mode });
      record.readerStopCalled = true;
    } catch (cause) {
      failures.push(error('lifecycle_failed', `reader stop failed: ${describeThrown(cause)}`, { providerId: record.instance.providerId, facet: 'reader', cause }));
    }
  }
}
