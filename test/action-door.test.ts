/** door 注解:ui_invoke 必须自己交代"这个能力有没有人能看见的门"。
 *  起因(2026-08-04):agent 无头调用 trajectory.read,用户问"它从哪点出来的?"
 *  —— 答案是哪都点不出来,但当时没人告诉用户。 */
import { describe, expect, it } from 'bun:test';
import { findVisibleDoor } from '../src/kernel/action-door';

const MENUS = {
  file: [
    { id: 'file.save', label: '保存', kind: 'command', commandId: 'editor.save', keybinding: 'Ctrl+S' },
    { id: 'file.openRecent', label: '打开最近', kind: 'submenu', dynamic: true },
  ],
  window: [
    { id: 'window.chat', label: '聊天', kind: 'command', commandId: 'panel.toggle_chatpanel' },
    { id: 'window.sub', label: '布局', kind: 'submenu', children: [
      { id: 'window.sub.reset', label: '重置布局', kind: 'command', commandId: 'layout.reset' },
    ] },
  ],
};

describe('findVisibleDoor', () => {
  it('工作区模式切换:rail 面无发布者 → 门位未知,不给死路径也不指控 headless', () => {
    // 2026-08-06(B1):旧 railMode 分支**不查任何投影**就返回最高置信度 found +
    // rail: 路径,而 host.sidebar 全树零发布者 —— open('rail:...') 必死,文案还让
    // agent 请用户"打开页面"(页面明明开着)。下线后 app.set_mode 落到 shell-widget
    // 未知档:界面上那两个页签仍然真实可见,但 AI 无法沿它可见执行 —— 如实说未知。
    const toAi = findVisibleDoor({ menus: MENUS, rail: [] }, 'app.set_mode', { mode: 'ai' });
    expect(toAi.certainty).toBe('unknown');
    expect(toAi.path).toBeUndefined();
    expect(toAi.hint).toContain('门位未知');
    expect(toAi.hint).not.toContain("open('rail:");
  });

  it('菜单投影缺席时不指控 headless —— 那是未知,不是否定', () => {
    // 页面没打开/进程刚重启还没重新注册时菜单树为空。空对账源会把每一个有菜单门
    // 的能力都说成"界面上没有入口、屏幕不会变化",等于向用户隐瞒真实的点击路径。
    const door = findVisibleDoor({ menus: null, rail: [] }, 'editor.save');
    expect(door.visible).toBe(false);
    expect(door.hint).toContain('无法对账');
    expect(door.hint).not.toContain('很可能是 headless 能力');
  });

  it('shell 级动作没在菜单树里,不等于没门', () => {
    // app./panel./workbench. 的门在 rail 页签或侧栏控件上,本来就不在菜单树里。
    const door = findVisibleDoor({ menus: MENUS, rail: [] }, 'app.dock.reset');
    expect(door.visible).toBe(false);
    expect(door.certainty).toBe('unknown'); // 配不上 ≠ 无门 —— 不许指控 headless
    expect(door.hint).toContain('门位未知'); // 提示语为禁止而引用了那句话,故按未知措辞断言
    expect(door.hint).toContain('rail');
  });

  it('有门:给出 editor_ui_browse 可直接消费的链,并劝走人路径', () => {
    const door = findVisibleDoor(MENUS, 'panel.toggle_chatpanel');
    expect(door.visible).toBe(true);
    expect(door.path).toBe('menu:window/聊天');
    expect(door.hint).toContain("open('menu:window/聊天')");
  });

  it('子菜单里的门:链带完整前缀', () => {
    const door = findVisibleDoor(MENUS, 'layout.reset');
    expect(door.path).toBe('menu:window/布局/重置布局');
  });

  it('没门(如 trajectory.read):明说 headless,要求向用户说明屏幕不会变化', () => {
    const door = findVisibleDoor(MENUS, 'trajectory.read');
    expect(door.visible).toBe(false);
    expect(door.path).toBeUndefined();
    expect(door.hint).toContain('headless');
    expect(door.hint).toContain('屏幕上不会有任何变化');
  });

  it('rail 的门:workbench.open_plugin 反查到边栏页签,不再误标 headless', () => {
    const door = findVisibleDoor(
      { menus: MENUS, rail: [{ id: 'wb:observatory', label: 'Observatory · 轨迹观察台' }] },
      'workbench.open_plugin',
      { extensionId: '@forgeax-extension/wb-observatory' },
    );
    expect(door.visible).toBe(true);
    expect(door.path).toBe('rail:wb:observatory');
    expect(door.hint).toContain("open('rail:wb:observatory')");
  });

  it('rail 未收录的插件:说真话 —— 不在 rail,但工作台网格点得到', () => {
    // 2026-08-04:agent 教用户"点更多插件→选轨迹观察台",搜索结果"没有匹配的插件"。
    // 2026-08-05 修正:上一版据此断言"用户自己点不到" —— 只对了 rail 一个账源。
    // 实测工作台网格(installed − hidden)列出全部插件且 tile 可点。
    const door = findVisibleDoor(
      { menus: MENUS, rail: [{ id: 'wb:anim', label: '动画设计' }] },
      'workbench.open_plugin',
      { extensionId: '@forgeax-extension/wb-observatory' },
    );
    expect(door.visible).toBe(true);
    expect(door.hint).toContain('工作台网格');
    expect(door.hint).not.toContain('点不到');
    expect(door.walk).toBeUndefined(); // 网格路径无法自动行走,只交代,不改道
  });

  it('别名事实:game.switch 经 catalog door 解析到「打开最近」动态链,可自动行走', () => {
    // 同一能力两个 id(catalog=game.switch,菜单叶=game.pick)。对账凭别名事实
    // 把它们认成同一能力;动态子项凭投影声明的 id 构成事实(childIdFromArg)定位,
    // 无需展开动态列表 —— 这正是"注册表放事实、协议消费事实"的样板。
    const menusWithRecent = {
      file: [
        { id: 'file.openRecent', label: '打开最近', kind: 'submenu', dynamic: true,
          childCommandId: 'game.pick', childIdFromArg: 'slug' },
      ],
    };
    const door = findVisibleDoor(
      { menus: menusWithRecent, rail: [], fact: { menuCommandId: 'game.pick' } },
      'game.switch',
      { slug: 'tonight-no-human' },
    );
    expect(door.visible).toBe(true);
    expect(door.path).toBe('menu:file/打开最近');
    expect(door.walk).toEqual({
      chain: 'menu:file/打开最近',
      kind: 'dynamic-leaf',
      invoke: { parentId: 'file.openRecent', itemId: 'file.openRecent.tonight-no-human' },
    });
  });

  it('静态叶子等价:同 commandId 同 args → 可自动行走;args 不同 → 门在但不改道', () => {
    const menus = {
      help: [
        { id: 'help.shortcuts', label: '快捷键', kind: 'command',
          commandId: 'overlay.open', args: { id: 'settings', param: 'shortcuts' } },
      ],
    };
    const same = findVisibleDoor({ menus, rail: [] }, 'overlay.open', { id: 'settings', param: 'shortcuts' });
    expect(same.walk).toEqual({ chain: 'menu:help/快捷键', kind: 'static-leaf' });

    // 同一控件、不同目标状态(打开的是别的浮层)→ 人从这点,但这次调用不等价。
    // 2026-08-05 终审:此前这条分支照给 path + "去 open 它"的类级模板 —— 菜单只有
    // 「进入全屏」时,退出全屏的调用会被指去点它,执行相反动作还被指纹"验证"成功。
    const differ = findVisibleDoor({ menus, rail: [] }, 'overlay.open', { id: 'assets-browser' });
    expect(differ.visible).toBe(true);
    expect(differ.walk).toBeUndefined();
    expect(differ.path).toBeUndefined();
    expect(differ.certainty).toBe('declared');
    expect(differ.hint).not.toContain("open('");
    expect(differ.hint).toContain('相反');
  });

  it('无参数能力:调用方补的 {} 与投影省略的 args 视为等价 —— 护栏不因空对象失效', () => {
    // MCP shim 与 preflight 都把缺省参数补成 {};投影对无 args 的菜单项整个省略键。
    // 不归一,"无参数 + 有菜单门"的能力(如 panel.toggle_chatpanel)100% argsDiffer,
    // 咽喉改道永远不触发(2026-08-05 终审实测)。
    const door = findVisibleDoor(MENUS, 'panel.toggle_chatpanel', {});
    expect(door.walk).toEqual({ chain: 'menu:window/聊天', kind: 'static-leaf' });
  });

  it('role.open:rail 死门下线后按门位未知处理 —— 不给 rail: 路径,不指控 headless', () => {
    // 它的门(rail 的 Agents 页签)在界面上真实可见,只是 rail 未接入 surface 总线,
    // AI 无法沿它可见执行。说"未知"是事实;说 headless 是对着用户看得见的按钮撒谎;
    // 给 rail: 路径是把 agent 指向必死的 open。三者只有第一个诚实。
    const door = findVisibleDoor({ menus: MENUS, rail: [] }, 'role.open', {});
    expect(door.visible).toBe(false);
    expect(door.certainty).toBe('unknown');
    expect(door.path).toBeUndefined();
    expect(door.hint).toContain('门位未知');
    expect(door.hint).not.toContain('headless 能力');
  });

  it('菜单树缺席(页面没开)时不误判有门,措辞保持诚实', () => {
    const door = findVisibleDoor(null, 'editor.save');
    expect(door.visible).toBe(false);
  });
});
