/** ui_invoke 的门注解必须长在能力实现层。
 *
 *  2026-08-05 终审 P0:此前注解挂在 /:sid/perception-query 路由里,而 ui_invoke 的
 *  真实链路(MCP shim → kernel-tool → runForgeaxBuiltinTool 的进程内 perceptionQuery)
 *  从不经过那条路由 —— "没门的能力必须明说"这条硬约束等于从未装上:agent 调
 *  trajectory.read 拿到的返回体里既没有 door 也没有 headless 说明。
 *  本测试钉住:任何经 annotateUiInvokeResult 出去的 ui_invoke 结果都带 door。 */
import { describe, expect, it, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { createBusRouter } from '../src/api/bus';
import { annotateUiInvokeResult } from '../src/kernel/forgeax-builtin-tools';
import { buildActionCatalog } from '../src/kernel/action-catalog';

describe('annotateUiInvokeResult — 能力层门注解', () => {
  let app: Hono;
  beforeAll(async () => {
    buildActionCatalog(); // door 事实要从构建后的 catalog 里查
    app = new Hono();
    app.route('/api/bus', createBusRouter());
    await app.request('/api/bus/ui/surfaces/host.menubar/snapshot', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: { menus: { file: [
        { id: 'file.save', label: '保存', kind: 'command', commandId: 'editor.save' },
      ] } } }),
    });
  });

  it('真 headless(trajectory.read):door 明说没门,要求向用户说明屏幕不会变化', () => {
    const out = annotateUiInvokeResult({ rows: [] }, 'trajectory.read', {}) as {
      door: { visible: boolean; certainty: string; hint: string };
    };
    expect(out.door.visible).toBe(false);
    expect(out.door.certainty).toBe('none');
    expect(out.door.hint).toContain('headless');
  });

  it('role.open:rail 死门下线后注解为门位未知 —— 不再给 rail:agents 死路径', () => {
    // 2026-08-06(B1):host.sidebar 无发布者,给 rail: 路径 = 指 agent 走必死的
    // open,失败文案还会让它请用户"打开页面"。未知才是诚实档。
    const out = annotateUiInvokeResult({ opened: true }, 'role.open', {}) as {
      door: { visible: boolean; certainty: string; path?: string; hint: string };
    };
    expect(out.door.visible).toBe(false);
    expect(out.door.certainty).toBe('unknown');
    expect(out.door.path).toBeUndefined();
    expect(out.door.hint).not.toContain("open('rail:");
  });

  it('非对象/空 actionId 原样放行,注解失败不拦执行结果', () => {
    expect(annotateUiInvokeResult('raw-text', 'role.open', {})).toBe('raw-text');
    expect(annotateUiInvokeResult({ a: 1 }, '', {})).toEqual({ a: 1 });
  });
});
