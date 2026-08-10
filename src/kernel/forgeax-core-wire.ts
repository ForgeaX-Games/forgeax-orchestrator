/**
 * 原生内核(forgeax-core)的 unix-socket 线格式映射。
 *
 * 单独成文件的理由:这是一份**白名单**序列化 —— 漏掉一个字段就是一条静默失效的链路
 * (`permissionMode` 就这么漏过一次:sidecar 侧会 applyMode,但永远收不到值,于是设置页
 * 选的权限档对原生内核完全无效)。放进独立模块后它不再牵连内核实现的重依赖,可以被单测
 * 直接钉住。
 */
import type { TurnRequest } from '@forgeax/agent-runtime';

export function toWire(req: TurnRequest): Record<string, unknown> {
  return {
    session: req.session,
    callId: req.callId,
    input: req.input,
    history: req.history,
    systemPrompt: req.systemPrompt,
    tools: req.tools,
    toolsRevision: req.toolsRevision,
    liveHostContext: req.liveHostContext,
    toolPolicy: req.toolPolicy,
    budget: req.budget,
    model: req.model,
    fallbackModels: req.fallbackModels,
    trustTier: req.trustTier,
    // 本轮权限档位。sidecar 侧 forgeax-core 在 runTurn 起始处会
    // `applyMode(translateNeutral(req.permissionMode))`;不填默认值,缺省交 sidecar 自己兜。
    permissionMode: req.permissionMode,
    hostSessionId: req.hostSessionId,
    // 全链路 trace:把上游 W3C traceparent 透过 unix-socket 带进 sidecar,
    //   sidecar 的 kernel.turn 据此挂成上游 span 的 child(否则在边界被丢)。
    traceparent: req.traceparent,
  };
}
