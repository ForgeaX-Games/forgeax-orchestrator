import { BUILTIN_ACTION_DECLARATIONS } from './builtin-action-declarations';
import type { ActionCapability, ActionSurface, JsonValue, JsonSchemaObject, ActionCatalogEntry, ActionCatalogBuildOptions, ActionEffect, ActionPrecondition } from './action-catalog-contract';
export type { ActionCapability, ActionSurface, JsonValue, JsonSchemaObject, ActionCatalogEntry, ActionCatalogBuildOptions, ActionEffect, ActionPrecondition } from './action-catalog-contract';
export { HEADLESS_ACTION_GRANDFATHER_IDS } from './action-catalog-contract';
const VALID_CAPABILITIES: ReadonlySet<string> = new Set<ActionCapability>([
	"read",
	"write",
	"delete",
	"exec",
	"network",
	"credential",
	"delegate",
	"other",
]);

const VALID_SURFACES: ReadonlySet<string> = new Set<ActionSurface>([
	"ui",
	"server",
	"both",
]);
const VALID_EFFECTS: ReadonlySet<string> = new Set<ActionEffect>([
	"read",
	"write",
	"destructive",
	"external-side-effect",
]);

interface ActionCatalogSnapshot {
	readonly all: readonly ActionCatalogEntry[];
	readonly firstClass: readonly ActionCatalogEntry[];
	readonly byId: ReadonlyMap<string, ActionCatalogEntry>;
}

const EMPTY_ENTRIES = Object.freeze([]) as readonly ActionCatalogEntry[];

let currentCatalog: ActionCatalogSnapshot = Object.freeze({
	all: EMPTY_ENTRIES,
	firstClass: EMPTY_ENTRIES,
	byId: new Map<string, ActionCatalogEntry>(),
});
let activeHeadlessRegistryOptions:
	| Readonly<ActionCatalogBuildOptions>
	| undefined;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function invalidJson(path: string): never {
	throw new Error(`schema contains a non-JSON value at ${path}`);
}

function cloneAndFreezeJson(
	value: unknown,
	path: string,
	ancestors: Set<object>,
): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalidJson(path);
		return value;
	}
	if (typeof value !== "object") invalidJson(path);

	const objectValue = value as object;
	if (ancestors.has(objectValue)) invalidJson(path);
	ancestors.add(objectValue);

	if (Array.isArray(value)) {
		const clone: JsonValue[] = [];
		for (let index = 0; index < value.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor?.enumerable || !("value" in descriptor))
				invalidJson(`${path}[${index}]`);
			clone.push(
				cloneAndFreezeJson(descriptor.value, `${path}[${index}]`, ancestors),
			);
		}
		if (Reflect.ownKeys(value).length !== value.length + 1) invalidJson(path);
		ancestors.delete(objectValue);
		return Object.freeze(clone);
	}

	if (!isPlainObject(value)) invalidJson(path);
	const clone: Record<string, JsonValue> = {};
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") invalidJson(path);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor))
			invalidJson(`${path}.${key}`);
		Object.defineProperty(clone, key, {
			value: cloneAndFreezeJson(descriptor.value, `${path}.${key}`, ancestors),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	ancestors.delete(objectValue);
	return Object.freeze(clone);
}

function requireString(
	raw: Record<string, unknown>,
	field: string,
	declarationIndex: number,
): string {
	const value = raw[field];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(
			`ActionCatalog: declaration ${declarationIndex} has invalid ${field}`,
		);
	}
	return value;
}

function compileEntry(
	raw: unknown,
	declarationIndex: number,
): ActionCatalogEntry {
	if (!isPlainObject(raw)) {
		throw new Error(
			`ActionCatalog: declaration ${declarationIndex} must be a plain object`,
		);
	}

	const id = requireString(raw, "id", declarationIndex);
	const title = requireString(raw, "title", declarationIndex);
	const description = requireString(raw, "description", declarationIndex);
	const capability = raw.capability;
	if (typeof capability !== "string" || !VALID_CAPABILITIES.has(capability)) {
		throw new Error(
			`ActionCatalog: action "${id}" has unsupported capability "${String(capability)}"`,
		);
	}

	const compileSchema = (
		field: "argsSchema" | "resultSchema",
	): JsonSchemaObject => {
		const value = raw[field];
		if (!isPlainObject(value)) {
			throw new Error(
				`ActionCatalog: action "${id}" ${field} must be a plain JSON object`,
			);
		}
		try {
			return cloneAndFreezeJson(
				value,
				`$${field}`,
				new Set(),
			) as JsonSchemaObject;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`ActionCatalog: action "${id}" ${reason}`);
		}
	};
	const argsSchema = compileSchema("argsSchema");
	const resultSchema = compileSchema("resultSchema");

	const effect = raw.effect;
	if (typeof effect !== "string" || !VALID_EFFECTS.has(effect)) {
		throw new Error(
			`ActionCatalog: action "${id}" has unsupported effect "${String(effect)}"`,
		);
	}
	const exposedToAI = raw.exposedToAI;
	if (typeof exposedToAI !== "boolean") {
		throw new Error(
			`ActionCatalog: action "${id}" must explicitly declare exposedToAI`,
		);
	}
	const requireConfirm = raw.requireConfirm;
	if (typeof requireConfirm !== "boolean") {
		throw new Error(
			`ActionCatalog: action "${id}" must explicitly declare requireConfirm`,
		);
	}
	if (
		(effect === "destructive" || effect === "external-side-effect") &&
		!requireConfirm
	) {
		throw new Error(
			`ActionCatalog: action "${id}" effect ${JSON.stringify(effect)} requires confirmation`,
		);
	}

	const surface = raw.surface;
	if (
		surface !== undefined &&
		(typeof surface !== "string" || !VALID_SURFACES.has(surface))
	) {
		throw new Error(
			`ActionCatalog: action "${id}" has unsupported surface "${String(surface)}"`,
		);
	}

	const timeoutMs = raw.timeoutMs;
	if (
		timeoutMs !== undefined &&
		(typeof timeoutMs !== "number" ||
			!Number.isFinite(timeoutMs) ||
			timeoutMs <= 0)
	) {
		throw new Error(`ActionCatalog: action "${id}" has invalid timeoutMs`);
	}

	const firstClass = raw.firstClass;
	if (firstClass !== undefined && typeof firstClass !== "boolean") {
		throw new Error(
			`ActionCatalog: action "${id}" has invalid firstClass flag`,
		);
	}

	if (!Array.isArray(raw.preconditions)) {
		throw new Error(
			`ActionCatalog: action "${id}" preconditions must be an array`,
		);
	}
	const preconditionIds = new Set<string>();
	const preconditions = Object.freeze(
		raw.preconditions.map((value, index) => {
			if (!isPlainObject(value)) {
				throw new Error(
					`ActionCatalog: action "${id}" preconditions[${index}] must be a plain object`,
				);
			}
			const allowedKeys = new Set(["id", "description", "errorCode"]);
			const unknownKeys = Object.keys(value).filter(
				(key) => !allowedKeys.has(key),
			);
			if (unknownKeys.length > 0) {
				throw new Error(
					`ActionCatalog: action "${id}" preconditions[${index}] has unknown keys ${unknownKeys.join(",")}`,
				);
			}
			const requirePreconditionString = (
				field: "id" | "description" | "errorCode",
			): string => {
				const fieldValue = value[field];
				if (typeof fieldValue !== "string" || !fieldValue.trim()) {
					throw new Error(
						`ActionCatalog: action "${id}" preconditions[${index}].${field} must be a non-empty string`,
					);
				}
				return fieldValue;
			};
			const itemId = requirePreconditionString("id");
			const itemDescription = requirePreconditionString("description");
			const errorCode = requirePreconditionString("errorCode");
			if (preconditionIds.has(itemId)) {
				throw new Error(
					`ActionCatalog: action "${id}" has duplicate precondition id "${itemId}"`,
				);
			}
			preconditionIds.add(itemId);
			return Object.freeze({
				id: itemId,
				description: itemDescription,
				errorCode,
			});
		}),
	) as readonly ActionPrecondition[];

	// door 门位事实:构建层必须原样放行 —— 2026-08-05 实测,这里的白名单静默丢掉了
	// door,门对账拿不到别名事实,咽喉改道整条失效(agent 又走回无头直调)。
	// 2026-08-06:railTab/railMode 随 rail 死门下线一并撤出合法键 —— 有人重新声明时
	// 这里会大声报错,提醒先把 rail 面发布回 surface 总线再恢复 action-door 分支。
	let door: ActionCatalogEntry["door"];
	if (raw.door !== undefined) {
		if (!isPlainObject(raw.door))
			throw new Error(
				`ActionCatalog: action "${id}" door must be a plain object`,
			);
		const { menuCommandId, ...rest } = raw.door as Record<string, unknown>;
		if (Object.keys(rest).length)
			throw new Error(
				`ActionCatalog: action "${id}" door has unknown keys ${Object.keys(rest).join(",")}`,
			);
		if (menuCommandId !== undefined && typeof menuCommandId !== "string")
			throw new Error(
				`ActionCatalog: action "${id}" door.menuCommandId must be a string`,
			);
		door = Object.freeze({
			...(menuCommandId !== undefined ? { menuCommandId } : {}),
		});
	}

	return Object.freeze({
		id,
		title,
		description,
		argsSchema,
		resultSchema,
		schema: argsSchema,
		preconditions,
		effect: effect as ActionEffect,
		exposedToAI,
		requireConfirm,
		capability: capability as ActionCapability,
		...(surface !== undefined ? { surface: surface as ActionSurface } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(firstClass !== undefined ? { firstClass } : {}),
		...(door !== undefined ? { door } : {}),
	});
}

function isHeadlessSurface(entry: ActionCatalogEntry): boolean {
	return entry.surface === "server" || entry.surface === "both";
}

function validateRegistryIds(
	ids: readonly string[],
	label: "handler" | "grandfather",
	issues: string[],
): Set<string> {
	if (!Array.isArray(ids)) {
		issues.push(`${label} action ids must be an array`);
		return new Set();
	}

	const unique = new Set<string>();
	for (const [index, id] of ids.entries()) {
		if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
			issues.push(`${label} action id at index ${index} is invalid`);
			continue;
		}
		if (unique.has(id)) {
			issues.push(`duplicate headless ${label} action ${JSON.stringify(id)}`);
			continue;
		}
		unique.add(id);
	}
	return unique;
}

function validateHeadlessRegistry(
	entries: readonly ActionCatalogEntry[],
	byId: ReadonlyMap<string, ActionCatalogEntry>,
	options: ActionCatalogBuildOptions,
): void {
	const issues: string[] = [];
	const handlerIds = validateRegistryIds(
		options.headlessHandlerActionIds,
		"handler",
		issues,
	);
	const builtinIds = validateRegistryIds(
		options.builtinHeadlessHandlerActionIds ?? [],
		"handler",
		issues,
	);
	for (const id of builtinIds) {
		// A complete host catalog may omit generic capabilities. Explicit host
		// handlers take precedence, exactly as in the execution seam.
		if (byId.has(id)) handlerIds.add(id);
	}
	const grandfatherIds = validateRegistryIds(
		options.grandfatheredHeadlessActionIds,
		"grandfather",
		issues,
	);

	for (const id of handlerIds) {
		const entry = byId.get(id);
		if (!entry) {
			issues.push(
				`orphan headless handler ${JSON.stringify(id)} is not declared`,
			);
		} else if (!isHeadlessSurface(entry)) {
			issues.push(
				`orphan headless handler ${JSON.stringify(id)} targets non-headless surface ${JSON.stringify(entry.surface ?? "ui")}`,
			);
		}
	}

	for (const id of grandfatherIds) {
		const entry = byId.get(id);
		if (!entry) {
			issues.push(`headless grandfather ${JSON.stringify(id)} is not declared`);
		} else if (!isHeadlessSurface(entry)) {
			issues.push(
				`headless grandfather ${JSON.stringify(id)} targets non-headless surface ${JSON.stringify(entry.surface ?? "ui")}`,
			);
		} else if (handlerIds.has(id)) {
			issues.push(
				`headless grandfather ${JSON.stringify(id)} has a handler and must be removed`,
			);
		}
	}

	for (const entry of entries) {
		if (
			isHeadlessSurface(entry) &&
			!handlerIds.has(entry.id) &&
			!grandfatherIds.has(entry.id)
		) {
			issues.push(
				`missing headless handler for action ${JSON.stringify(entry.id)}`,
			);
		}
	}

	if (issues.length > 0) {
		throw new Error(
			`ActionCatalog: headless registry mismatch:\n- ${issues.join("\n- ")}`,
		);
	}
}

/**
 * Validate and publish a complete catalog in one swap. Failed builds leave the
 * previously published snapshot untouched.
 */
export function buildActionCatalog(
	declarations: readonly unknown[] = BUILTIN_ACTION_DECLARATIONS,
	options?: ActionCatalogBuildOptions,
): readonly ActionCatalogEntry[] {
	if (!Array.isArray(declarations)) {
		throw new Error("ActionCatalog: declarations must be an array");
	}

	const byId = new Map<string, ActionCatalogEntry>();
	const entries: ActionCatalogEntry[] = [];
	for (const [index, raw] of declarations.entries()) {
		const entry = compileEntry(raw, index);
		if (byId.has(entry.id)) {
			throw new Error(`ActionCatalog: duplicate action id "${entry.id}"`);
		}
		byId.set(entry.id, entry);
		entries.push(entry);
	}

	const validationOptions = options ?? activeHeadlessRegistryOptions;
	if (validationOptions)
		validateHeadlessRegistry(entries, byId, validationOptions);

	const all = Object.freeze(entries);
	const firstClass = Object.freeze(
		entries.filter((entry) => entry.firstClass === true),
	);
	const next = Object.freeze({ all, firstClass, byId });
	currentCatalog = next;
	if (options) {
		activeHeadlessRegistryOptions = Object.freeze({
			headlessHandlerActionIds: Object.freeze([
				...options.headlessHandlerActionIds,
			]),
			builtinHeadlessHandlerActionIds: Object.freeze([
				...(options.builtinHeadlessHandlerActionIds ?? []),
			]),
			grandfatheredHeadlessActionIds: Object.freeze([
				...options.grandfatheredHeadlessActionIds,
			]),
		});
	}
	return next.all;
}

export function _resetActionCatalogValidationForTests(): void {
	activeHeadlessRegistryOptions = undefined;
}

export function catalogGet(id: string): ActionCatalogEntry | undefined {
	return currentCatalog.byId.get(id);
}

export function catalogFirstClass(): readonly ActionCatalogEntry[] {
	return currentCatalog.firstClass;
}

export function catalogAll(): readonly ActionCatalogEntry[] {
	return currentCatalog.all;
}
