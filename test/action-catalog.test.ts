import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	_resetActionCatalogValidationForTests,
	catalogAll,
	catalogFirstClass,
	catalogGet,
	type ActionCatalogBuildOptions,
	type ActionCatalogEntry,
} from "../src/kernel/action-catalog";
import {
	buildActionCatalog,
	HEADLESS_ACTION_GRANDFATHER_IDS,
} from "./fixtures/host-action-catalog";

const CURRENT_HEADLESS_HANDLER_IDS = Object.freeze([
	"sessions.list",
	"session.create",
	"session.close",
	"role.create",
	"role.list",
]);

let previousConformanceFlag: string | undefined;

function registryOptions(
	overrides: Partial<ActionCatalogBuildOptions> = {},
): ActionCatalogBuildOptions {
	return {
		headlessHandlerActionIds: CURRENT_HEADLESS_HANDLER_IDS,
		grandfatheredHeadlessActionIds: HEADLESS_ACTION_GRANDFATHER_IDS,
		...overrides,
	};
}

beforeEach(() => {
	previousConformanceFlag = process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE;
	delete process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE;
	_resetActionCatalogValidationForTests();
	buildActionCatalog();
});

afterEach(() => {
	_resetActionCatalogValidationForTests();
	if (previousConformanceFlag === undefined) {
		delete process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE;
	} else {
		process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE = previousConformanceFlag;
	}
});

describe("ActionCatalog", () => {
	test("状态前置条件经构建存活,且首批声明只描述世界状态", () => {
		const preconditions = (id: string) => catalogGet(id)?.preconditions;

		expect(preconditions("extension.open")).toEqual([
			{
				id: "extension-page-available",
				description:
					"The target extension contributes an available singleton page.",
				errorCode: "extension-page-not-available",
			},
		]);
		expect(preconditions("role.open")).toEqual([
			{
				id: "role-exists-when-provided",
				description:
					"When id is provided, it identifies a role in the current roster.",
				errorCode: "role-not-found",
			},
			{
				id: "active-session-exists-when-binding",
				description:
					"When id is provided, an active chat session exists for the role binding.",
				errorCode: "active-session-not-found",
			},
		]);
		expect(preconditions("game.switch")?.[0]).toMatchObject({
			id: "game-exists",
			errorCode: "game-not-found",
		});
		expect(preconditions("overlay.open")?.[0]).toMatchObject({
			id: "overlay-registered",
			errorCode: "overlay-not-registered",
		});
		expect(preconditions("role.create")?.[0]).toMatchObject({
			id: "role-id-available",
			errorCode: "role-id-conflict",
		});
		expect(preconditions("game.create")?.[0]).toMatchObject({
			id: "game-slug-available",
			errorCode: "game-slug-conflict",
		});
		expect(preconditions("panel.toggle_sidebar")).toEqual([]);
	});

	test("三条已知 description 只解释能力,不夹带操作顺序", () => {
		expect(catalogGet("extension.open")?.description).toBe(
			"Open the Page contributed by a specific extension id. Discover valid ids via extension.list.",
		);
		expect(catalogGet("role.list")?.description).toBe(
			"List all currently dispatchable roles (plugin agents + built-ins). Returns { count, roles:[{id,role,displayName,source}] }.",
		);
		expect(catalogGet("game.create")?.description).toBe(
			"Create a new game (project) from the template and give it its own dedicated chat session. The action does not switch the UI to the new game.",
		);
	});

	test("preconditions 必须是结构化事实数组;空数组合法,坏形状拒绝且不替换目录", () => {
		const base = catalogAll()[0]!;
		buildActionCatalog([
			{ ...base, id: "valid.empty-preconditions", preconditions: [] },
		]);
		expect(catalogGet("valid.empty-preconditions")?.preconditions).toEqual([]);
		buildActionCatalog();
		const before = catalogAll();
		const invalidValues: unknown[] = [
			"ready",
			[1],
			[""],
			[{ id: "", description: "ready", errorCode: "not-ready" }],
			[{ id: "ready", description: "", errorCode: "not-ready" }],
			[{ id: "ready", description: "ready", errorCode: "" }],
			[
				{
					id: "ready",
					description: "ready",
					errorCode: "not-ready",
					extra: true,
				},
			],
			[
				{ id: "ready", description: "ready", errorCode: "not-ready" },
				{
					id: "ready",
					description: "still ready",
					errorCode: "still-not-ready",
				},
			],
		];

		for (const [index, preconditions] of invalidValues.entries()) {
			expect(() =>
				buildActionCatalog([
					{ ...base, id: `invalid.preconditions.${index}`, preconditions },
				]),
			).toThrow(/preconditions/);
			expect(catalogAll()).toBe(before);
		}
	});

	test("preconditions 由构建器复制并冻结,调用方不能在发布后改写目录事实", () => {
		const source = [
			{
				id: "ready",
				description: "The world is ready.",
				errorCode: "not-ready",
			},
		];
		buildActionCatalog([
			{ ...catalogAll()[0], id: "frozen.preconditions", preconditions: source },
		]);
		const stored = catalogGet("frozen.preconditions")!.preconditions;

		expect(stored).toEqual(source);
		expect(stored).not.toBe(source);
		expect(Object.isFrozen(stored)).toBe(true);
		expect(Object.isFrozen(stored[0])).toBe(true);
		source[0]!.description = "mutated";
		expect(stored[0]?.description).toBe("The world is ready.");
	});

	test("door metadata survives compilation for registered actions", () => {
		const door = { menuCommandId: "sample.open" };
		buildActionCatalog([
			{
				...catalogAll()[0],
				id: "sample.open",
				title: "Open",
				capability: "read",
				surface: "ui",
				door,
			},
		]);
		expect(catalogGet("sample.open")?.door).toEqual(door);
		expect(catalogGet("game.switch")).toBeUndefined();
	});
	test("atomically assembles all 23 trusted action declarations", () => {
		const catalog = catalogAll();

		expect(catalog).toHaveLength(23);
		expect(new Set(catalog.map((entry) => entry.id)).size).toBe(23);
		expect(catalogGet("role.create")).toMatchObject({
			capability: "delegate",
			surface: "both",
			firstClass: true,
			timeoutMs: 15_000,
		});
		expect(catalogGet("role.list")).toMatchObject({
			capability: "read",
			surface: "both",
			firstClass: true,
		});
		expect(catalogGet("role.open")).toMatchObject({
			capability: "read",
			surface: "ui",
			firstClass: true,
		});
		expect(catalogGet("panel.toggle_sidebar")?.schema).toEqual(
			catalogGet("panel.toggle_sidebar")?.argsSchema,
		);
		expect(catalogFirstClass()).toHaveLength(12);
		expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
		expect(
			catalog.every((entry) => !("run" in entry) && !("available" in entry)),
		).toBe(true);
	});

	test("conformance stack can register one hidden probe without changing the normal catalog", () => {
		expect(catalogGet("forgeax.conformance.hidden")).toBeUndefined();

		process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE = "1";
		const catalog = buildActionCatalog();

		expect(catalog).toHaveLength(24);
		expect(catalogGet("forgeax.conformance.hidden")).toMatchObject({
			exposedToAI: false,
			effect: "read",
			surface: "ui",
		});

		delete process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE;
		expect(buildActionCatalog()).toHaveLength(23);
		expect(catalogGet("forgeax.conformance.hidden")).toBeUndefined();
	});

	test("accepts the complete headless registry and the frozen four-item grandfather", () => {
		expect(HEADLESS_ACTION_GRANDFATHER_IDS).toEqual([
			"game.create",
			"game.switch",
			"session.rename",
			"sessions.refresh",
		]);
		expect(Object.isFrozen(HEADLESS_ACTION_GRANDFATHER_IDS)).toBe(true);

		const catalog = buildActionCatalog(undefined, registryOptions());
		expect(
			catalog.filter(
				(entry) => entry.surface === "both" || entry.surface === "server",
			),
		).toHaveLength(9);
	});

	test("revalidates later bare rebuilds with the last successful registry options", () => {
		buildActionCatalog(undefined, registryOptions());
		const before = catalogAll();

		expect(() =>
			buildActionCatalog([
				...before,
				{
					...before[0],
					id: "later.headless.action",
					title: "Later headless action",
					capability: "read",
					surface: "both",
				},
			]),
		).toThrow('missing headless handler for action "later.headless.action"');
		expect(catalogAll()).toBe(before);
	});

	test("rejects a missing headless handler without replacing the catalog", () => {
		const before = catalogAll();
		expect(() =>
			buildActionCatalog(
				undefined,
				registryOptions({
					headlessHandlerActionIds: CURRENT_HEADLESS_HANDLER_IDS.filter(
						(id) => id !== "role.list",
					),
				}),
			),
		).toThrow('missing headless handler for action "role.list"');
		expect(catalogAll()).toBe(before);
	});

	test("rejects duplicate headless handlers", () => {
		expect(() =>
			buildActionCatalog(
				undefined,
				registryOptions({
					headlessHandlerActionIds: [
						...CURRENT_HEADLESS_HANDLER_IDS,
						"role.list",
					],
				}),
			),
		).toThrow('duplicate headless handler action "role.list"');
	});

	test("rejects orphan and non-headless handlers", () => {
		expect(() =>
			buildActionCatalog(
				undefined,
				registryOptions({
					headlessHandlerActionIds: [
						...CURRENT_HEADLESS_HANDLER_IDS,
						"outside.catalog",
					],
				}),
			),
		).toThrow('orphan headless handler "outside.catalog" is not declared');

		expect(() =>
			buildActionCatalog(
				undefined,
				registryOptions({
					headlessHandlerActionIds: [
						...CURRENT_HEADLESS_HANDLER_IDS,
						"role.open",
					],
				}),
			),
		).toThrow(
			'orphan headless handler "role.open" targets non-headless surface "ui"',
		);
	});

	test("forces a stale grandfather entry to be removed when a handler lands", () => {
		expect(() =>
			buildActionCatalog(
				undefined,
				registryOptions({
					headlessHandlerActionIds: [
						...CURRENT_HEADLESS_HANDLER_IDS,
						"game.create",
					],
				}),
			),
		).toThrow(
			'headless grandfather "game.create" has a handler and must be removed',
		);
	});

	test("rejects unknown and non-headless grandfather entries", () => {
		expect(() =>
			buildActionCatalog(
				undefined,
				registryOptions({
					grandfatheredHeadlessActionIds: [
						...HEADLESS_ACTION_GRANDFATHER_IDS,
						"outside.catalog",
					],
				}),
			),
		).toThrow('headless grandfather "outside.catalog" is not declared');

		expect(() =>
			buildActionCatalog(
				undefined,
				registryOptions({
					grandfatheredHeadlessActionIds: [
						...HEADLESS_ACTION_GRANDFATHER_IDS,
						"role.open",
					],
				}),
			),
		).toThrow(
			'headless grandfather "role.open" targets non-headless surface "ui"',
		);
	});

	test("rejects a duplicate id without publishing a partial catalog", () => {
		const before = catalogAll();
		const duplicate = { ...before[0] };

		expect(() => buildActionCatalog([...before, duplicate])).toThrow(
			'ActionCatalog: duplicate action id "panel.toggle_sidebar"',
		);
		expect(catalogAll()).toBe(before);
		expect(catalogAll()).toHaveLength(23);
	});

	test("rejects args/result schemas that are not pure JSON objects without replacing the catalog", () => {
		const before = catalogAll();
		const base = before[0];

		expect(() =>
			buildActionCatalog([
				{ ...base, id: "invalid.schema.array", argsSchema: [] },
			]),
		).toThrow(
			'ActionCatalog: action "invalid.schema.array" argsSchema must be a plain JSON object',
		);

		expect(() =>
			buildActionCatalog([
				{
					...base,
					id: "invalid.schema.value",
					resultSchema: {
						type: "object",
						properties: { value: { default: () => true } },
					},
				},
			]),
		).toThrow(
			/ActionCatalog: action "invalid\.schema\.value" schema contains a non-JSON value/,
		);

		const sparseEnum = new Array(1);
		expect(() =>
			buildActionCatalog([
				{
					...base,
					id: "invalid.schema.sparse",
					argsSchema: { type: "object", enum: sparseEnum },
				},
			]),
		).toThrow(
			/ActionCatalog: action "invalid\.schema\.sparse" schema contains a non-JSON value/,
		);

		expect(catalogAll()).toBe(before);
		expect(catalogAll()).toHaveLength(23);
	});

	test("preserves JSON __proto__ keys without mutating object prototypes", () => {
		const base = catalogAll()[0];
		const schema = JSON.parse(
			'{"type":"object","properties":{"__proto__":{"type":"string"}}}',
		) as Record<string, unknown>;

		buildActionCatalog([{ ...base, id: "json.proto-key", argsSchema: schema }]);
		const compiledSchema = catalogGet("json.proto-key")!.schema!;
		const properties = compiledSchema.properties as Record<string, unknown>;

		expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
		expect(Object.prototype.hasOwnProperty.call(properties, "__proto__")).toBe(
			true,
		);
		expect(properties.__proto__).toEqual({ type: "string" });
	});

	test("rejects capabilities outside the eight-value policy enum", () => {
		const before = catalogAll();
		const invalid = {
			...before[0],
			id: "invalid.capability",
			capability: "admin",
		} as unknown as ActionCatalogEntry;

		expect(() => buildActionCatalog([invalid])).toThrow(
			'ActionCatalog: action "invalid.capability" has unsupported capability "admin"',
		);
		expect(catalogAll()).toBe(before);
	});

	test("publishes deeply frozen arrays, entries, and schemas", () => {
		const all = catalogAll();
		const firstClass = catalogFirstClass();
		const entry = catalogGet("extension.open")!;
		const schema = entry.schema!;
		const properties = schema.properties as Record<string, unknown>;
		const extensionId = properties.extensionId as Record<string, unknown>;

		expect(Object.isFrozen(all)).toBe(true);
		expect(Object.isFrozen(firstClass)).toBe(true);
		expect(Object.isFrozen(entry)).toBe(true);
		expect(Object.isFrozen(schema)).toBe(true);
		expect(Object.isFrozen(properties)).toBe(true);
		expect(Object.isFrozen(extensionId)).toBe(true);

		expect(() => {
			(all as ActionCatalogEntry[]).push(entry);
		}).toThrow();
		expect(() => {
			(entry as { title: string }).title = "mutated";
		}).toThrow();
		expect(() => {
			extensionId.type = "number";
		}).toThrow();

		expect(catalogAll()).toHaveLength(23);
		expect(catalogGet("extension.open")?.title).toBe("打开扩展页面");
		expect(
			(
				catalogGet("extension.open")?.schema?.properties as Record<
					string,
					unknown
				>
			).extensionId,
		).toEqual({ type: "string" });
	});
});
