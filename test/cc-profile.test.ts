import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { buildMcpArgs } from "../src/kernel/cc-profile";
import { FORGEAX_BUILTIN_TOOL_NAMES } from "../src/kernel/compose-turn-request";
import {
	authorizeKernelToolCapability,
	resetKernelToolCapabilitiesForTests,
} from "../src/kernel/kernel-tool-capability";

const request = {
	tools: [
		{ name: "npc_wire", description: "wire", inputSchema: { type: "object" } },
	],
	session: { agentId: "forge" },
	hostSessionId: "sid",
} as never;

const originalPermissionServerEntry =
	process.env.FORGEAX_PERMISSION_SERVER_ENTRY;

afterEach(() => {
	if (originalPermissionServerEntry === undefined)
		delete process.env.FORGEAX_PERMISSION_SERVER_ENTRY;
	else
		process.env.FORGEAX_PERMISSION_SERVER_ENTRY = originalPermissionServerEntry;
});

function fxtEnv(toolNames: string[]): Record<string, string> {
	const req = {
		tools: toolNames.map((name) => ({
			name,
			description: name,
			inputSchema: { type: "object" },
		})),
		session: { agentId: "forge" },
		hostSessionId: "sid",
	} as never;
	const args = buildMcpArgs(req, "sid");
	const configPath = args[args.indexOf("--mcp-config") + 1];
	expect(configPath).toBeTruthy();
	const config = JSON.parse(readFileSync(configPath!, "utf8")) as {
		mcpServers?: { fxt?: { env?: Record<string, string> } };
	};
	return config.mcpServers?.fxt?.env ?? {};
}

describe("cc builtin adoption surface", () => {
	afterEach(() => resetKernelToolCapabilitiesForTests());
	test("uses the product-owned permission MCP entry in kernel profiles", () => {
		process.env.FORGEAX_PERMISSION_SERVER_ENTRY =
			"/tmp/forgeax packaged/permission-server.mjs";
		const args = buildMcpArgs(request, "sid");
		const configPath = args[args.indexOf("--mcp-config") + 1];
		const config = JSON.parse(readFileSync(configPath!, "utf8")) as {
			mcpServers?: { forgeax?: { args?: string[] } };
		};
		expect(config.mcpServers?.forgeax?.args).toEqual([
			"/tmp/forgeax packaged/permission-server.mjs",
		]);
	});

	test("keeps npc_wire local to the forgeax builtin MCP server", () => {
		const args = buildMcpArgs(request, "sid");
		const configPath = args[args.indexOf("--mcp-config") + 1];
		expect(configPath).toBeTruthy();
		const config = JSON.parse(readFileSync(configPath!, "utf8")) as {
			mcpServers?: { fxt?: { env?: Record<string, string> } };
		};
		expect(
			config.mcpServers?.fxt?.env?.FORGEAX_TOOL_SPECS_FILE,
		).toBeUndefined();
	});

	test("fxt exposure derives purely from req.tools — builtins absent there stay unexposed", () => {
		// The opt-in gate lives in compose; the profile must never re-add a builtin.
		const expose = fxtEnv(["list_games"]).FORGEAX_FXT_EXPOSE ?? "";
		const exposed = new Set(expose.split(",").filter(Boolean));
		for (const builtin of FORGEAX_BUILTIN_TOOL_NAMES) {
			expect(exposed.has(builtin)).toBe(false);
		}
		expect(exposed.has("list_games")).toBe(true);
	});

	test("writes a private MCP config with a source capability bound to the turn", () => {
		const args = buildMcpArgs(request, "sid");
		const configPath = args[args.indexOf("--mcp-config") + 1]!;
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			mcpServers?: { fxt?: { env?: Record<string, string> } };
		};
		const token = config.mcpServers?.fxt?.env?.FORGEAX_KERNEL_TOOL_TOKEN;
		expect(token).toBeTruthy();
		expect(authorizeKernelToolCapability(token, "sid", "npc_wire")).toEqual({
			sid: "sid",
			agentPath: "forge",
		});
	});
});
