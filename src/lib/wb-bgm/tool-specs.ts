/** Shared wb-bgm agent tool specs (name + description + input schema), pure
 *  data. The wb-bgm LOGIC moved to the marketplace plugin (@forgeax-extension/
 *  wb-bgm); these specs remain server-side only so the two GLOBAL exposure
 *  forwarders can name/describe the tools without re-declaring schemas:
 *    - builtin/kits/bgm/tools/* (native agents) spread a spec and add `execute`
 *      that forwards to the plugin via the Host ToolRegistry (callTool).
 *    - the stdio MCP server (cli-providers/mcp/forgeax-tools-server.mjs) maps a
 *      spec to { inputSchema } and adds `run` that POSTs /api/tools/call
 *      (external CLI providers: cursor-agent / claude-code / codex).
 *  Keep this module dependency-free (plain data) so the .mjs MCP server can
 *  import it without dragging in server runtime modules. */

export interface BgmToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const SEARCH_AUDIO_SPEC: BgmToolSpec = {
  name: "search-audio",
  description:
    "旧版单标签搜索，仅供BGM和回归对比使用。SFX必须使用resolve-audio-plan。" +
    "在 Local 库搜索BGM(kind=bgm)/音效(kind=sfx),按tag匹配。query与kind均必填:" +
    "query 传单个英文单词(小写 tag,如 battle / click),kind 传 bgm 或 sfx。返回 " +
    "{ assetId, name, kind, version, resUrl } 列表;assetId + resUrl 用于后续 attach-audio。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "单个英文单词(tag,小写),必填,如 battle / click / jump" },
      kind: { type: "string", enum: ["bgm"], description: "AI旧检索仅允许bgm；SFX使用resolve-audio-plan" },
      limit: { type: "number", description: "返回条数,缺省 20,1..200" },
    },
    required: ["query", "kind"],
  },
};

export const SEARCH_BGM_SPEC: BgmToolSpec = {
  name: "search-bgm",
  description:
    "BGM结构化检索。先把玩家需求转成scene/moodIds/energy/world，再调用本工具。" +
    "scene是主要场景；moodIds最多2项；energy为low/medium/high；world仅在需求明确时填写。" +
    "文件名/目录是硬标签，CLAP只补情绪与能量软标签。返回真实assetId/resUrl、匹配等级、原因、放宽项。" +
    "优先使用本工具，不再把复杂BGM需求压成search-audio的单个英文tag。",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["bgm"], description: "固定为bgm" },
      queryText: { type: "string", description: "玩家原始BGM描述或曲目关键词" },
      scene: {
        type: "string",
        enum: [
          "menu_lobby",
          "exploration_ambient",
          "combat",
          "boss_combat",
          "narrative_emotion",
          "puzzle_casual",
          "strategy_management",
          "competition",
          "result_event",
          "general_theme",
        ],
        description: "主要使用场景，核心条件",
      },
      moodIds: {
        type: "array",
        maxItems: 2,
        uniqueItems: true,
        items: {
          type: "string",
          enum: ["calm", "tense", "dark", "mysterious", "epic", "warm", "sad", "playful"],
        },
        description: "情绪，最多两项",
      },
      energy: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "能量强度",
      },
      world: {
        type: "string",
        enum: [
          "eastern_fantasy",
          "western_fantasy",
          "sci_fi_cyber",
          "historical_culture",
          "modern_urban",
          "post_apocalyptic",
          "neutral_general",
        ],
        description: "世界观；不明确时省略",
      },
      topK: { type: "integer", minimum: 1, maximum: 20, description: "返回曲目数，缺省5" },
      dryRun: { type: "boolean", description: "true仅测试本地目录，不返回可挂载URL" },
    },
    required: ["kind"],
  },
};

export const RESOLVE_AUDIO_PLAN_SPEC: BgmToolSpec = {
  name: "resolve-audio-plan",
  description:
    "把策划案拆出的SFX Audio Plan一次批量解析为可调用音效族。" +
    "每项必须提供稳定eventId和标准cue，可选共享在线目录directoryCategory/directorySubcategory及source/targetMaterial/intensity/exclude。" +
    "返回exact/fallback/gap、真实Live variants、命中理由和明确降级项；不使用数值质量门槛。",
  input_schema: {
    type: "object",
    properties: {
      schemaVersion: { type: "string", description: "建议audio-plan/1" },
      planId: { type: "string", description: "稳定计划ID；可省略让服务生成" },
      projectId: { type: "string", description: "项目声音配置ID，通常与slug一致" },
      slug: { type: "string", description: "目标游戏slug，透传给结果" },
      topK: { type: "integer", minimum: 1, maximum: 10, description: "每个事件候选族数量，缺省3" },
      dryRun: { type: "boolean", description: "true只查索引，不返回可挂载URL" },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "稳定游戏事件ID" },
            playerGoal: { type: "string", description: "要向玩家传达的反馈" },
            kind: { type: "string", enum: ["sfx"] },
            cue: { type: "string", description: "标准事件，如combat.attack.impact" },
            directoryCategory: { type: "string", description: "与玩家端共用的一级在线目录ID，如3_combat" },
            directorySubcategory: { type: "string", description: "与玩家端共用的二级在线目录ID，如melee" },
            source: { type: "string", description: "声源，如sword/creature" },
            targetMaterial: { type: "string", description: "材质，如metal/flesh" },
            intensity: { type: "string", description: "light/medium/heavy" },
            exclude: { type: "array", items: { type: "string" } },
            variantCount: { type: "integer", minimum: 1, maximum: 8 },
            priority: { type: "string", description: "core/normal/decorative" },
          },
          required: ["eventId", "playerGoal", "cue"],
        },
      },
    },
    required: ["projectId", "items"],
  },
};

export const APPLY_AUDIO_PLAN_SPEC: BgmToolSpec = {
  name: "apply-audio-plan",
  description:
    "批量应用resolve-audio-plan的items。内部读取并校验现有manifest，复用已挂载资产，" +
    "下载缺失变体，幂等更新manifest与audio/cues.json，最后返回pendingBindings。" +
    "不要在调用前再调用list-audio。",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "目标游戏slug" },
      planId: { type: "string", description: "resolve-audio-plan返回的planId" },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        description: "直接传resolve-audio-plan返回的items",
        items: {
          type: "object",
          properties: {
            eventId: { type: "string" },
            status: { type: "string", enum: ["exact", "fallback", "gap", "error"] },
            familyId: { type: "string" },
            selectedFamily: {
              type: "object",
              properties: {
                familyId: { type: "string" },
                variants: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      assetId: { type: "string" },
                      name: { type: "string" },
                      version: { type: "string" },
                      resUrl: { type: "string" },
                    },
                    required: ["assetId", "resUrl"],
                  },
                },
              },
            },
          },
          required: ["eventId"],
        },
      },
    },
    required: ["slug", "planId", "items"],
  },
};

const AUDIO_PROJECT_LOCATOR_PROPERTIES = {
  slug: { type: "string", description: "目标游戏slug" },
  projectId: { type: "string", description: "音频项目ID；缺省与slug相同" },
};

export const INSPECT_AUDIO_EVENTS_SPEC: BgmToolSpec = {
  name: "inspect-audio-events",
  description:
    "只读扫描游戏源码中的真实事件候选。返回已有gameAudio.emit/play、EventBus.emit、旧audio.play和直接sfx.playX调用的文件、行号、来源与置信度。" +
    "先用本工具定位事件，再提出音频绑定草稿；不要把中等置信度候选当作已完成绑定。",
  input_schema: {
    type: "object",
    properties: AUDIO_PROJECT_LOCATOR_PROPERTIES,
    required: ["slug"],
  },
};

export const GET_AUDIO_PROJECT_SPEC: BgmToolSpec = {
  name: "get-audio-project",
  description:
    "读取用户与Agent共用的音频事件绑定草稿、当前revision和最近appliedRevision。" +
    "每次编辑前先读取，避免覆盖用户刚做的修改。",
  input_schema: {
    type: "object",
    properties: AUDIO_PROJECT_LOCATOR_PROPERTIES,
    required: ["slug"],
  },
};

const AUDIO_BINDING_SCHEMA = {
  type: "object",
  properties: {
    eventId: { type: "string", description: "稳定语义事件ID" },
    label: { type: "string", description: "用户可读名称" },
    enabled: { type: "boolean" },
    kind: { type: "string", enum: ["sfx", "music", "voice"] },
    assets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          assetId: { type: "string" },
          file: { type: "string", description: "相对游戏audio/目录的文件路径" },
          name: { type: "string" },
        },
        required: ["assetId", "file"],
      },
    },
    variation: {
      type: "object",
      properties: { mode: { type: "string", enum: ["single", "sequential", "random-no-repeat"] } },
      required: ["mode"],
    },
    trigger: {
      type: "object",
      properties: {
        delayMs: { type: "number", minimum: 0, maximum: 3600000 },
        cooldownMs: { type: "number", minimum: 0, maximum: 3600000 },
        probability: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["delayMs", "cooldownMs", "probability"],
    },
    playback: {
      type: "object",
      properties: {
        volume: { type: "number", minimum: 0, maximum: 4 },
        bus: { type: "string", enum: ["sfx", "music", "voice"] },
        spatial: { type: "string", enum: ["2d", "3d"] },
        mode: { type: "string", enum: ["one-shot", "loop"] },
        fadeInMs: { type: "number", minimum: 0, maximum: 60000 },
        fadeOutMs: { type: "number", minimum: 0, maximum: 60000 },
        stopEventId: { type: "string" },
      },
      required: ["volume", "bus", "spatial", "mode", "fadeInMs", "fadeOutMs"],
    },
    conditions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          operator: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in"] },
          value: {},
        },
        required: ["field", "operator", "value"],
      },
    },
  },
  required: ["eventId", "kind", "assets"],
};

export const PATCH_AUDIO_PROJECT_SPEC: BgmToolSpec = {
  name: "patch-audio-project",
  description:
    "按expectedRevision增删或更新音频绑定草稿。支持替换资产、启停绑定、delay/cooldown/probability、" +
    "single/sequential/random-no-repeat、音量/总线/循环淡入淡出、2D/3D和简单条件。" +
    "冲突会返回revision_conflict，必须重新get后合并，禁止盲目覆盖。",
  input_schema: {
    type: "object",
    properties: {
      ...AUDIO_PROJECT_LOCATOR_PROPERTIES,
      expectedRevision: { type: "integer", minimum: 0 },
      upsertBindings: { type: "array", items: AUDIO_BINDING_SCHEMA },
      removeEventIds: { type: "array", uniqueItems: true, items: { type: "string" } },
    },
    required: ["slug", "expectedRevision"],
  },
};

export const APPLY_AUDIO_PROJECT_SPEC: BgmToolSpec = {
  name: "apply-audio-project",
  description:
    "应用用户已经预览的expectedRevision草稿：校验资产并生成src/forgeax-audio运行时与applied项目。" +
    "该插件工具对AI调用要求用户确认；不要跳过预览直接应用。",
  input_schema: {
    type: "object",
    properties: {
      ...AUDIO_PROJECT_LOCATOR_PROPERTIES,
      expectedRevision: { type: "integer", minimum: 0 },
    },
    required: ["slug", "expectedRevision"],
  },
};

export const VERIFY_AUDIO_PROJECT_SPEC: BgmToolSpec = {
  name: "verify-audio-project",
  description:
    "验证已应用音频项目的资产文件、生成运行时和真实gameAudio.emit/play插桩。" +
    "返回结构化errors/warnings；修复后重复验证直到ok=true。",
  input_schema: {
    type: "object",
    properties: AUDIO_PROJECT_LOCATOR_PROPERTIES,
    required: ["slug"],
  },
};

export const SEARCH_AUDIO_V2_SPEC: BgmToolSpec = {
  name: "search-audio-v2",
  description:
    "结构化搜索SFX。把用户需求转换为cue/source/targetMaterial/intensity/exclude/projectId，" +
    "服务端执行硬过滤、规则评分和familyId去重。返回Top K候选、score、reasons、relaxed及可挂载资产。" +
    "测试时传dryRun=true；BGM仍使用search-audio。",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["sfx"], description: "当前固定为sfx" },
      cue: {
        type: "string",
        description: "标准游戏事件，如combat.attack.impact / combat.attack.swing / movement.footstep.walk",
      },
      directoryCategory: { type: "string", description: "与玩家端共用的一级在线目录ID，作为硬过滤条件" },
      directorySubcategory: { type: "string", description: "与玩家端共用的二级在线目录ID，需配合directoryCategory" },
      source: { type: "string", description: "声音来源，如sword / bow / creature" },
      targetMaterial: { type: "string", description: "作用材质，如flesh / metal / wood" },
      intensity: { type: "string", description: "力度，如light / medium / heavy" },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: "明确排除项，如voice / music / reverb_long / sci_fi",
      },
      projectId: { type: "string", description: "项目声音世界配置ID；未配置时回退default并返回warning" },
      topK: { type: "integer", minimum: 1, maximum: 10, description: "不同音效族候选数，缺省3" },
      dryRun: { type: "boolean", description: "true仅测试本地索引，不请求Live资产" },
    },
    required: ["kind", "cue", "projectId"],
  },
};

export const ATTACH_AUDIO_SPEC: BgmToolSpec = {
  name: "attach-audio",
  description:
    "把一条 BGM/音效下载到 .forgeax/games/<slug>/audio/ 并 upsert 到 audio/manifest.json" +
    "(按 assetId 幂等)。assetId/resUrl/name/version 取自 search-audio 或 search-audio-v2 的Live结果,勿编造resUrl。" +
    "slug 必填:必须显式传入目标游戏的 slug。",
  input_schema: {
    type: "object",
    properties: {
      assetId: { type: "string", description: "资产id(来自search-audio或search-audio-v2 Live结果)" },
      kind: { type: "string", enum: ["bgm", "sfx"], description: "bgm 或 sfx" },
      resUrl: { type: "string", description: "COS下载地址(来自搜索结果,勿编造)" },
      name: { type: "string", description: "曲目名;sfx 建议用稳定短名(如 hit/score)" },
      version: { type: "string", description: "版本号(来自搜索结果)" },
      slug: { type: "string", description: "目标游戏 slug(必填):必须显式传入,不自动探测" },
      filename: { type: "string", description: "落盘文件名;缺省从 name/url 推导" },
    },
    required: ["assetId", "kind", "resUrl", "slug"],
  },
};

export const LIST_AUDIO_SPEC: BgmToolSpec = {
  name: "list-audio",
  description:
    "兼容用人工诊断工具：读取 .forgeax/games/<slug>/audio/manifest.json。" +
    "AI流程不得调用；apply-audio-plan已内置读取、校验和复用。",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "目标游戏 slug(必填):必须显式传入,不自动探测" },
    },
    required: ["slug"],
  },
};

/** All wb-bgm tool specs, in catalog order. */
export const BGM_TOOL_SPECS: BgmToolSpec[] = [
  SEARCH_BGM_SPEC,
  RESOLVE_AUDIO_PLAN_SPEC,
  APPLY_AUDIO_PLAN_SPEC,
  INSPECT_AUDIO_EVENTS_SPEC,
  GET_AUDIO_PROJECT_SPEC,
  PATCH_AUDIO_PROJECT_SPEC,
  APPLY_AUDIO_PROJECT_SPEC,
  VERIFY_AUDIO_PROJECT_SPEC,
];
