// @desc Command module: agents — per-session RuntimeTree（list / get / spawn / delete）
//
// session 容器 CRUD 走 `/api/sessions/*` REST。本模块只管运行时 agent 树：
//   - list_agents / get_agent  —— 只读
//   - add_agent               —— 从已注册 templateRef 启动 ephemeral
//   - delete_agent            —— ephemeral 取消；resident 走内存优先删除事务
//
// args 一律 positional string[]：
//   list_agents     args[0]=sid
//   get_agent       args[0]=sid, args[1]=agentPath|instanceId
//   add_agent       args[0]=sid, args[1]=templateRef, args[2]?=parent
//   delete_agent    args[0]=sid, args[1]=agentPath|instanceId

import { existsSync } from "node:fs";
import type { CommandModule } from "../../src/commands/types";
import { BLACKBOARD_KEYS } from "../../src/defaults/blackboard-vars";

const agents: CommandModule = {
  async list() {
    return [
      {
        name: "list_agents",
        description: "Session RuntimeTree 全部实例（含 identity/lifetime/state/templateRef）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "get_agent",
        description: "单个运行时 Agent 详情（args[0]=sid, args[1]=resident path 或 instanceId）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "add_agent",
        description:
          "从已注册 templateRef 创建 idle ephemeral Agent（args[0]=sid, args[1]=templateRef, args[2]?=parent）；创建不启动 turn",
        hasQuery: false,
        hasExecute: true,
      },
      {
        name: "delete_agent",
        description:
          "删除 Agent：ephemeral 取消；resident 先删内存子树，再递归删除其配置目录",
        hasQuery: false,
        hasExecute: true,
      },
    ];
  },

  async query(name, args, ctx) {
    if (name === "list_agents") {
      const sid = (args[0] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      // The frontend polls list_agents on WS connect / active-session switch,
      // and the sid can briefly point at a session that no longer exists (e.g.
      // a stale `forgeax.activeSid` in localStorage). A missing session is not
      // an error here — return an empty roster so AgentsPanel renders its empty
      // state instead of surfacing a 500. (open() throws "session not found".)
      if (!existsSync(ctx.paths.session(sid).configFile())) {
        return { sid, agents: [] };
      }
      const session = await ctx.sm.open(sid);
      const list = session.tree.list().map((node) => {
        const instance = session.tree.resolve(node.path)!;
        return {
          path: node.path,
          instanceId: instance.instanceId,
          runtimeEpochId: instance.runtimeEpochId,
          lifetime: instance.lifetime,
          state: instance.state,
          templateRef: instance.templateRef,
          display: node.display,
          depth: node.depth,
          fullId: node.fullId,
          parent: node.parent ?? null,
          hasLedger: Boolean(session.supervisor.getEventStore(instance.instanceId)),
          running:
            instance.state === "running" ||
            session.blackboard.get(node.path, BLACKBOARD_KEYS.RUNNING) === true,
        };
      });
      return { sid, agents: list };
    }

    if (name === "get_agent") {
      const sid = (args[0] ?? "").trim();
      const agentPath = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);
      const session = await ctx.sm.open(sid);
      const instance = session.tree.resolve(agentPath);
      if (!instance) throw new Error(`${name}: runtime agent not found: ${agentPath}`);
      const address = session.tree.addressOf(instance);
      const node = session.tree.get(address)!;
      return {
        sid,
        agent: {
          path: address,
          instanceId: instance.instanceId,
          runtimeEpochId: instance.runtimeEpochId,
          lifetime: instance.lifetime,
          state: instance.state,
          templateRef: instance.templateRef,
          display: node.display,
          depth: node.depth,
          fullId: node.fullId,
          parent: node.parent ?? null,
          children: session.tree.children(node.path).map((c) => c.path),
          hasLedger: Boolean(session.supervisor.getEventStore(instance.instanceId)),
          running:
            instance.state === "running" ||
            session.blackboard.get(node.path, BLACKBOARD_KEYS.RUNNING) === true,
        },
      };
    }

    throw new Error(`No query for: ${name}`);
  },

  async execute(name, args, ctx) {
    if (name === "add_agent") {
      const sid = (args[0] ?? "").trim();
      const templateRef = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!templateRef) throw new Error(`${name}: args[1] (templateRef) required`);
      const session = await ctx.sm.open(sid);
      if (!session.templateCatalog.get(templateRef)) {
        throw new Error(`${name}: unknown templateRef: ${templateRef}`);
      }
      const parentRaw = (args[2] ?? "").trim();
      const parent = parentRaw ? session.tree.resolve(parentRaw) : undefined;
      if (parentRaw && !parent) {
        throw new Error(`${name}: parent runtime agent not found: ${parentRaw}`);
      }
      const handle = await session.spawnEphemeral({
        parentInstanceId: parent?.instanceId ?? null,
        templateRef,
      });
      return {
        sid,
        instanceId: handle.instanceId,
        templateRef,
        lifetime: "ephemeral",
        created: true,
      };
    }

    if (name === "delete_agent") {
      const sid = (args[0] ?? "").trim();
      const agentPath = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);

      const session = await ctx.sm.open(sid);
      const instance = session.tree.resolve(agentPath);
      if (!instance) {
        return { sid, agentPath, existed: false, removed: false };
      }
      if (instance.lifetime === "ephemeral") {
        await session.supervisor.cancel(instance.instanceId, "deleted by command");
        return {
          sid,
          agentPath: instance.instanceId,
          instanceId: instance.instanceId,
          lifetime: "ephemeral",
          existed: true,
          removed: true,
        };
      }
      const result = await session.deleteResident(instance.residentPath!);
      return {
        sid,
        agentPath: instance.residentPath,
        instanceId: instance.instanceId,
        lifetime: "resident",
        existed: true,
        removed: result.ok,
        result,
      };
    }

    throw new Error(`No execute for: ${name}`);
  },
};

export default agents;
