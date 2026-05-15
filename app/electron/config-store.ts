import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 用户配置存储:JSON 文件落在 Electron 的 userData 目录,跨升级保留。
 */

/**
 * 一个 Skill = 一段独立的 system prompt + 显示名。
 * 用户可创建多个 skill 切换(例如:默认桌宠 / 编程助手 / 翻译)。
 */
export interface Skill {
  id: string;
  name: string;
  systemPrompt: string;
}

/** 角色对话 persona — 每个 Live2D 模型可以有多个 persona,
 *  用户在 AI 设置面板按角色编辑/新增/删除/切换 active。 */
export interface CharacterPersonaEntry {
  id: string;
  /** persona 名(用户能看到的标签,比如「魔女」「小冷」) */
  name: string;
  /** AI 自称的显示名 */
  displayName: string;
  /** 性格描述 */
  personality: string;
  /** 说话风格(可选) */
  speakingStyle?: string;
}

/** 一个角色的 persona 集合 + 当前 active 的 id */
export interface CharacterPersonaSlot {
  personas: CharacterPersonaEntry[];
  activeId: string;
}

/** 外部 skill 仓库源 — 来自 GitHub 的 SKILL.md 集合(addyosmani/agent-skills 风格) */
export interface AgentSkillSource {
  /** 简短 id,用作 skill id 前缀和缓存目录名(英文小写) */
  id: string;
  /** GitHub owner/name */
  repo: string;
  /** 分支,默认 main */
  branch: string;
  /** 用户可单独禁用某个源 */
  enabled: boolean;
}

export interface AgentSkillsConfig {
  /** 总开关 — 关闭后 AI 看不到 list_skills/query_skill 工具,system prompt 也不引导用 */
  enabled: boolean;
  /** 启用的外部 skill 仓库列表 */
  sources: AgentSkillSource[];
  /** 被用户单独禁用的本地 skill 的 rawId 列表(local 源不在 sources 里,所以单独存) */
  localDisabled?: string[];
  /** 启用的内置 skill 的 rawId 白名单(默认全关,只有在名单里的才启用) */
  builtinEnabled?: string[];
}

export const DEFAULT_AGENT_SKILLS: AgentSkillsConfig = {
  enabled: true,
  sources: [
    {
      id: 'addyosmani',
      repo: 'addyosmani/agent-skills',
      branch: 'main',
      enabled: true,
    },
    {
      id: 'qiushi',
      repo: 'HughYau/qiushi-skill',
      branch: 'main',
      enabled: true,
    },
  ],
};

export interface AppConfig {
  /** OpenAI 兼容 baseURL,例如 https://api.openai.com/v1 / https://api.deepseek.com */
  baseURL: string;
  /** API Key */
  apiKey: string;
  /** 当前选中的 LLM 模型名,例如 gpt-4o-mini / deepseek-chat */
  model: string;
  /** 模型名预设列表 — 用户可以保存多个常用 model 名,在 AI 设置面板下拉切换 */
  modelPresets?: string[];
  /** 至少 1 个 skill;activeSkillId 指向其中某一个 */
  skills: Skill[];
  activeSkillId: string;
  /** 全局长期记忆 — 用户可在 AI 设置面板里手动编辑;
   *  每次对话都会自动作为 system prompt 的一部分注入,让 AI"记住"这些内容 */
  memory: string;
  /** 按 character.name 分桶的 persona 配置。可空(用代码默认)。 */
  characterPersonas?: Record<string, CharacterPersonaSlot>;
  /** 应用启动时默认打开的角色 id。为空或角色不存在时,回退到第一只 hatch-pet。 */
  defaultCharacterId?: string;
  /** 锁定模型位置 — 开启后拖动不会移动窗口，避免误拖。默认 false。 */
  lockPosition?: boolean;
  /** 编码(增强)模式 — 占位字段，UI 上已提供开关，具体增强逻辑待后续实现。默认 false。 */
  codingMode?: boolean;
  /** 语音输入设置。 */
  voiceWake?: VoiceWakeConfig;
  /** 用户上传的自定义 vosk 语音识别模型文件名，文件实际存在 userData/vosk/<file>。
   *  不设 = 用内置的 small 中文模型；设了 = vosk-shared 会优先加载这个模型。 */
  voskCustomModelFile?: string;
  /** MCP(Model Context Protocol)工具 — 让 AI 能读写本地文件等。 */
  mcp?: McpConfig;
  /** Agent Skills — 来自在线源、本地上传和内置的 SKILL.md 知识库。
   *  AI 在相关问题前可调 list_skills/query_skill 拿对应参考。默认开启。 */
  agentSkills?: AgentSkillsConfig;
  /** 主动互动增强:让桌宠"活起来"。默认全关,用户在设置里勾选才生效。 */
  proactive?: ProactiveConfig;
  /** 多厂商配置预设 — 每个 profile = 一组 baseURL+apiKey+model+modelPresets。
   *  用户在 AI 设置面板顶部下拉切换。当前激活的 profile 的字段会同步写入
   *  顶层 baseURL/apiKey/model/modelPresets,所以 ai-client 不用改读取逻辑。 */
  providerProfiles?: ProviderProfile[];
  /** 当前激活的 profile id。空 = 用顶层 baseURL/apiKey 字段(向后兼容) */
  activeProviderId?: string;
  /** 视觉辅助 — 主模型不识图时用辅助模型先描述图片,再把描述拼回主模型。 */
  visionAssist?: VisionAssistConfig;
  /** 通用模型辅助 — AI 觉得自己干不动某项任务时,可调 delegate_to_model 让别的模型帮忙。 */
  generalAssist?: GeneralAssistConfig;
}

/** 视觉辅助配置。
 *  - enabled=true 且当前主 model 疑似不支持 vision(关键词不命中) + 用户消息含图 →
 *    用 assistantProfileId/assistantModel 指定的 model 先描述图,再用文字喂给主模型。
 *  - 指定的辅助 model 也疑似不识图(或没指定) + fallbackAcrossAll=true →
 *    扫所有 providerProfiles 的 modelPresets,关键词匹配首个疑似 vision 的 model 当辅助。 */
export interface VisionAssistConfig {
  /** 总开关 */
  enabled: boolean;
  /** 指定辅助 model 所在的 providerProfile id;为空表示未指定 */
  assistantProfileId?: string;
  /** 指定的辅助 model 名(必须是上面 profile 的 modelPresets 之一) */
  assistantModel?: string;
  /** 全员兜底:指定的辅助也不能识图时,自动从所有 profile 找一个 vision model */
  fallbackAcrossAll: boolean;
}

/** 通用模型辅助配置。
 *  enabled=true 时:
 *  - system prompt 注入「可调度模型清单」让 AI 知道身边有哪些模型
 *  - 把 app__delegate_to_model 工具暴露给 AI(干不动时主动调用,经用户确认后用别的模型代答)
 *  assistantProfileId/Model 是 AI 没指定 target 时的默认辅助。 */
export interface GeneralAssistConfig {
  /** 总开关 */
  enabled: boolean;
  /** 默认辅助 model 所在的 providerProfile id */
  assistantProfileId?: string;
  /** 默认辅助 model 名 */
  assistantModel?: string;
  /** 默认辅助也搞不定时,允许 AI 自由从所有 profile 的 modelPresets 里挑 model */
  fallbackAcrossAll: boolean;
  /** 跳过用户确认 — 信任 AI 自行委托其他 model,不再弹 confirm 弹窗。
   *  用户嫌频繁确认麻烦时打开。默认 false(每次弹)。 */
  skipConfirm?: boolean;
}

/** 一个保存下来的厂商配置 — 与 shared/provider-templates.ts 保持同构。
 *  这里复制类型定义而非 import,避免 main 进程依赖 shared(打包路径分离)。 */
export interface ProviderProfile {
  id: string;
  name: string;
  templateId?: string;
  baseURL: string;
  apiKey: string;
  model: string;
  modelPresets: string[];
}

/** 主动互动增强配置。所有触发都只在桌宠窗口可见 + 模型未隐藏时进行。 */
export interface ProactiveConfig {
  /** 总开关。关闭时下面的子开关全部失效,行为同没启用。 */
  enabled: boolean;
  /** 切换模型/角色后,主动用一句话打招呼。 */
  interactOnSwitch: boolean;
  /** 监听 Windows 前台应用变化,切到不同应用时主动搭话(如切到 VS Code 调侃"在写代码")。
   *  需要 get-windows npm 包,只支持 Windows / macOS。 */
  awareApps: boolean;
  /** 用户长时间停留同一应用时主动搭话一次(避免用户一直专注没人陪)。
   *  阈值见 idleStayMinutes。 */
  awareLongStay: boolean;
  /** 同应用停留多少分钟后触发"长停留"互动。默认 20。 */
  idleStayMinutes: number;
  /** 触发应用感知互动时,自动调 read_screen_elements 给 AI 当 context。
   *  注意会读屏幕内容,隐私敏感者谨慎开启。 */
  autoReadScreen: boolean;
  /** 切到浏览器(Edge/Chrome)时,自动调 BrowserMCP / Chrome MCP 工具读当前标签页内容。
   *  需要装好对应 MCP server + 浏览器扩展。 */
  autoReadBrowser: boolean;
}

const DEFAULT_PROACTIVE: ProactiveConfig = {
  enabled: false,
  interactOnSwitch: true,
  awareApps: false,
  awareLongStay: false,
  idleStayMinutes: 20,
  autoReadScreen: false,
  autoReadBrowser: false,
};

/** 一个 MCP server 的启动规格(stdio transport)。主进程会按此 spawn 子进程。 */
export interface McpServerSpec {
  /** 唯一 id,作为 tool 前缀(fs__read_file)。限 [a-z0-9_]。 */
  id: string;
  /** UI 显示名 */
  name: string;
  /** 启用开关(false 则不 spawn) */
  enabled: boolean;
  /** 启动命令。
   *  - 'bundled-fs':特殊值,使用本应用打包的 @modelcontextprotocol/server-filesystem,
   *     args 视为目录白名单;无需用户本机安装 Node。
   *  - 其它任意值:原样 spawn,如 'npx' / 'uvx' / 'node' / 绝对路径 exe。 */
  command: string;
  /** 命令行参数 */
  args: string[];
  /** 额外环境变量(合并进 process.env),常用于 API key */
  env?: Record<string, string>;
}

/** MCP 全局设置 */
export interface McpConfig {
  /** 总开关 — 关闭时不启动任何 server,AI 聊天也不带 tools 参数 */
  enabled: boolean;
  /** 所有 server 规格(可启用/停用)。空数组 = 没有工具可用。 */
  servers: McpServerSpec[];
  /** 写操作是否需要用户二次确认(write_file/edit_file/create_directory/move_file 等)。
   *  默认 true,强烈建议开启。 */
  confirmWrites: boolean;
}

/** 全局语音设置 */
export interface VoiceWakeConfig {
  /** 已废弃的旧版唤醒开关。新版写入时保持 false。 */
  enabled?: boolean;
  /** 对话框语音输入(听写):打开后对话框输入区显示 🎤 按钮,点击启用语音转文字。
   *  与 enabled 独立,仅在用户点击麦克风时加载识别模型。 */
  voiceInput?: boolean;
}

const DEFAULT_SKILL: Skill = {
  id: 'default',
  name: '默认',
  systemPrompt: '',
};

const DEFAULT: AppConfig = {
  baseURL: '',
  apiKey: '',
  model: '',
  skills: [DEFAULT_SKILL],
  activeSkillId: DEFAULT_SKILL.id,
  memory: '',
};

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** 旧版可能存的字段(systemPrompt 是单字符串)— 兼容迁移用 */
interface LegacyConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
  skills?: Skill[];
  activeSkillId?: string;
  memory?: string;
  characterPersonas?: Record<string, CharacterPersonaSlot>;
  defaultCharacterId?: string;
  modelPresets?: string[];
  lockPosition?: boolean;
  codingMode?: boolean;
  voiceWake?: VoiceWakeConfig;
  voskCustomModelFile?: string;
  mcp?: McpConfig;
  agentSkills?: AgentSkillsConfig;
  proactive?: ProactiveConfig;
  providerProfiles?: ProviderProfile[];
  activeProviderId?: string;
  visionAssist?: VisionAssistConfig;
  generalAssist?: GeneralAssistConfig;
}

/** 把保存里的 agentSkills 跟代码里的默认值合并:
 *  - 用户没配过 → 用 DEFAULT_AGENT_SKILLS
 *  - 用户配了部分字段 → 用户值优先,缺失字段回落默认
 *  - 把代码里新增的默认 source(用户保存时还没有的)合并进来,这样升级版本能自动获得新源 */
function migrateAgentSkills(raw: unknown): AgentSkillsConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_AGENT_SKILLS;
  const j = raw as Partial<AgentSkillsConfig>;
  const userSources = Array.isArray(j.sources) ? j.sources : [];
  // 合并默认 sources:用户已有的保留(可能改过 enabled),代码新增的补进来
  const merged: AgentSkillSource[] = [];
  const userIds = new Set<string>();
  for (const s of userSources) {
    if (s && typeof s.id === 'string' && typeof s.repo === 'string') {
      merged.push({
        id: s.id,
        repo: s.repo,
        branch: s.branch || 'main',
        enabled: s.enabled !== false,
      });
      userIds.add(s.id);
    }
  }
  for (const def of DEFAULT_AGENT_SKILLS.sources) {
    if (!userIds.has(def.id)) merged.push({ ...def });
  }
  return {
    enabled: j.enabled !== false, // 默认开
    sources: merged,
    localDisabled: Array.isArray(j.localDisabled)
      ? j.localDisabled.filter((x): x is string => typeof x === 'string')
      : [],
    builtinEnabled: Array.isArray(j.builtinEnabled)
      ? j.builtinEnabled.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

/** 迁移旧的 mcp 配置 — 若存在 filesystemRoots 但无 servers,自动生成一条 bundled-fs spec。
 *  默认 config(全新用户)返回 enabled=false 空 servers。 */
function migrateMcp(raw: unknown): McpConfig {
  if (!raw || typeof raw !== 'object') {
    // 默认开启 — builtin tools(http_fetch / http_search / list_skills / remember /
    // read_text_file / open_path 等)需要 enabled=true 才会传给 AI。servers 仍空,
    // 用户用到 fs 等高级能力时 AI 会引导他装。
    return { enabled: true, servers: [], confirmWrites: true };
  }
  const j = raw as {
    enabled?: boolean;
    servers?: McpServerSpec[];
    confirmWrites?: boolean;
    filesystemRoots?: string[];
  };
  let servers: McpServerSpec[] = Array.isArray(j.servers) ? j.servers : [];
  if (servers.length === 0 && Array.isArray(j.filesystemRoots) && j.filesystemRoots.length > 0) {
    servers = [
      {
        id: 'fs',
        name: 'Filesystem',
        enabled: true,
        command: 'bundled-fs',
        args: j.filesystemRoots.slice(),
      },
    ];
  }
  return {
    // 默认 enabled=true。只有"用户主动装过 server 但又显式关掉了"才尊重 false。
    // 这样从未碰过 MCP 设置的旧用户(enabled=false, servers=[])会被自动升级,
    // builtin tools(http_fetch / read_text_file / remember / install_mcp_server 等)
    // 全员可用。
    enabled: servers.length === 0 ? true : j.enabled !== false,
    servers,
    confirmWrites: j.confirmWrites !== false,
  };
}

/** 老用户首次升级到多厂商版本时,自动把顶层 baseURL/apiKey/model 迁移成第一个 profile。
 *  这样 UI 一打开下拉就能看到"我的配置"被激活,不会因为 UI 切预设丢失之前的 key。
 *
 *  关键:写盘后下次再读,profiles 已非空 → 不会重复迁移。所以**只在 loadConfig 里迁一次**,
 *  不要在 UI useEffect 里搞(那会因多次 mount + setConfig race 重复创建)。 */
function migrateProviderProfiles(
  existing: ProviderProfile[] | undefined,
  baseURL: string,
  apiKey: string,
  model: string,
  modelPresets: string[] | undefined,
): { profiles: ProviderProfile[]; activeId: string } | null {
  if (Array.isArray(existing) && existing.length > 0) return null; // 已有,跳过
  if (!baseURL.trim() && !apiKey.trim()) return null; // 全空,无需迁移
  // 简单 baseURL 匹配,猜厂商名(同步代码里的 PROVIDER_TEMPLATES,避免跨进程 import)
  const known: Array<{ name: string; baseURL: string; id: string }> = [
    { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
    { id: 'deepseek', name: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com/v1' },
    { id: 'deepseek', name: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com' },
    { id: 'zhipu', name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'qwen', name: '阿里通义 Qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'moonshot', name: '月之暗面 Kimi', baseURL: 'https://api.moonshot.cn/v1' },
    { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1' },
    { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' },
  ];
  const norm = baseURL.replace(/\/$/, '');
  const matched = known.find((k) => k.baseURL === norm);
  const profile: ProviderProfile = {
    id: 'p_' + Math.random().toString(36).slice(2, 10),
    name: matched?.name ?? '我的配置',
    templateId: matched?.id,
    baseURL,
    apiKey,
    model,
    modelPresets: modelPresets ?? [],
  };
  return { profiles: [profile], activeId: profile.id };
}

function migrate(j: LegacyConfig): AppConfig {
  // 多厂商 profile 功能已移除 — 不再做 providerProfiles 迁移。
  // 老配置里若有 providerProfiles 字段,原样保留(以防用户回滚到旧版本),但 UI 不读取。
  const base: AppConfig = {
    baseURL: j.baseURL ?? '',
    apiKey: j.apiKey ?? '',
    model: j.model ?? '',
    modelPresets: j.modelPresets ?? undefined,
    skills: j.skills && j.skills.length > 0 ? j.skills : [DEFAULT_SKILL],
    activeSkillId: j.activeSkillId ?? DEFAULT_SKILL.id,
    memory: j.memory ?? '',
    characterPersonas: j.characterPersonas ?? undefined,
    defaultCharacterId: typeof j.defaultCharacterId === 'string' ? j.defaultCharacterId : undefined,
    lockPosition: j.lockPosition ?? false,
    codingMode: j.codingMode ?? false,
    voiceWake: j.voiceWake ?? undefined,
    voskCustomModelFile: typeof j.voskCustomModelFile === 'string' ? j.voskCustomModelFile : undefined,
    mcp: migrateMcp(j.mcp),
    agentSkills: migrateAgentSkills(j.agentSkills),
    proactive: j.proactive ?? undefined,
    providerProfiles: Array.isArray(j.providerProfiles) ? j.providerProfiles : undefined,
    activeProviderId: j.activeProviderId ?? undefined,
    visionAssist: j.visionAssist ?? undefined,
    generalAssist: j.generalAssist ?? undefined,
  };
  // 旧版 systemPrompt 字符串 → 写入默认 skill(若 skills 还没人为修改过)
  if (j.systemPrompt && (!j.skills || j.skills.length === 0)) {
    base.skills = [{ ...DEFAULT_SKILL, systemPrompt: j.systemPrompt }];
  }
  // activeSkillId 必须指向存在的 skill
  if (!base.skills.some((s) => s.id === base.activeSkillId)) {
    base.activeSkillId = base.skills[0].id;
  }
  return base;
}

export function loadConfig(): AppConfig {
  const f = configPath();
  try {
    if (!fs.existsSync(f)) return { ...DEFAULT };
    const raw = fs.readFileSync(f, 'utf-8');
    const j = JSON.parse(raw) as LegacyConfig;
    const cfg = migrate(j);
    // 迁移发生时静默落盘,避免下次 loadConfig 重复迁移(每次会生成新 id)。
    // 判断条件:磁盘上的 providerProfiles 为空但 migrate 后非空 → 发生过迁移。
    const had = Array.isArray(j.providerProfiles) && j.providerProfiles.length > 0;
    const has = Array.isArray(cfg.providerProfiles) && cfg.providerProfiles.length > 0;
    if (!had && has) {
      try {
        fs.writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf-8');
      } catch {
        // 写盘失败不致命,下次启动会再次迁移(profile id 会变,但功能正常)
      }
    }
    return cfg;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[config] load failed, fallback default:', (e as Error).message);
    return { ...DEFAULT };
  }
}

/** 取主动互动配置,合并默认值(任何字段缺失走默认)。 */
export function getProactiveConfig(cfg: AppConfig): ProactiveConfig {
  return { ...DEFAULT_PROACTIVE, ...(cfg.proactive ?? {}) };
}

/** 取当前激活 skill 的 system prompt(空字符串表示无 / 未配置) */
export function getActiveSystemPrompt(cfg: AppConfig): string {
  const sk = cfg.skills.find((s) => s.id === cfg.activeSkillId);
  return sk?.systemPrompt ?? '';
}

export function saveConfig(next: Partial<AppConfig>): AppConfig {
  const cur = loadConfig();
  const merged: AppConfig = { ...cur, ...next };
  const f = configPath();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[config] save failed:', (e as Error).message);
    throw e;
  }
  return merged;
}
