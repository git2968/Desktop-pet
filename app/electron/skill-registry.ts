/**
 * skill-registry — 外部 SKILL.md 集合 (多源支持)。
 *
 * 默认装备的源:
 *  - addyosmani/agent-skills:Google 工程师 Addy Osmani 的 production-grade 编程指南
 *  - HughYau/qiushi-skill:中文向 skill 集合
 *
 * 用户可在设置面板里:
 *  - 总开关:agentSkills.enabled
 *  - 单个源开关:agentSkills.sources[i].enabled
 *  - 添加自定义源:任意 GitHub repo,只要有 skills/<name>/SKILL.md 结构都行
 *
 * 用法:
 *  - AI 通过 `app__list_skills` 看 id 列表 (id 形如 "addyosmani:react"、"qiushi:xxx")
 *  - AI 通过 `app__query_skill(skill_id)` 拿单个 skill 详细 md
 *  - 详细内容首次拉取后缓存到 `userData/skills/<source>/<skill>.md`
 *
 * 镜像策略(中国大陆访问 GitHub 不稳):
 *  raw.githubusercontent.com → cdn.jsdelivr.net 自动兜底
 */

import { net, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, type AgentSkillSource } from './config-store.js';
import { appEvents } from './app-events.js';

function skillsRoot(): string {
  return path.join(app.getPath('userData'), 'skills');
}
function sourceDir(sourceId: string): string {
  return path.join(skillsRoot(), sourceId);
}
function indexFile(sourceId: string): string {
  return path.join(sourceDir(sourceId), 'index.json');
}

export interface SkillEntry {
  /** 全限定 id,形如 "addyosmani:react" */
  id: string;
  /** 来源 source id */
  sourceId: string;
  /** 在源仓库里的目录名,如 "react" */
  rawId: string;
  /** 友好名字,默认就是 rawId */
  name: string;
  /** 是否已经拉过完整内容到本地缓存 */
  cached?: boolean;
}

/** 内存索引 — sourceId → SkillEntry[] */
let memIndex: Record<string, SkillEntry[]> = {};

/** 简单 HTTP GET 文本。8 秒超时。User-Agent 必填(GitHub API 要)。 */
function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    req.setHeader('User-Agent', 'desktop-pet/1.0 (+skill-registry)');
    req.setHeader('Accept', 'application/json, text/plain, */*');
    const t = setTimeout(() => {
      try {
        req.abort();
      } catch {
        // ignore
      }
      reject(new Error('skill fetch timeout'));
    }, timeoutMs);
    req.on('response', (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => {
        clearTimeout(t);
        const body = Buffer.concat(chunks).toString('utf-8');
        if ((resp.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${resp.statusCode} from ${url}`));
        } else {
          resolve(body);
        }
      });
      resp.on('error', (e: Error) => {
        clearTimeout(t);
        reject(e);
      });
    });
    req.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    req.end();
  });
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, '');
}

/** 把"全限定 id" "addyosmani:react" 拆成 (sourceId, rawId) */
function parseFqId(fqId: string): { sourceId: string; rawId: string } | null {
  const i = fqId.indexOf(':');
  if (i <= 0) return null;
  return { sourceId: fqId.slice(0, i), rawId: fqId.slice(i + 1) };
}

/** 拉某个 source 下某个 skill 的 SKILL.md — 先 raw.githubusercontent.com,失败回落 jsdelivr */
async function fetchSkillMd(src: AgentSkillSource, rawId: string): Promise<string> {
  const id = safeName(rawId);
  if (!id) throw new Error('invalid skill id');
  const branch = src.branch || 'main';
  const candidates = [
    `https://raw.githubusercontent.com/${src.repo}/${branch}/skills/${id}/SKILL.md`,
    `https://cdn.jsdelivr.net/gh/${src.repo}@${branch}/skills/${id}/SKILL.md`,
    // 有些 repo 把 SKILL 放在根目录(没 skills/ 前缀),兜底再试一遍
    `https://raw.githubusercontent.com/${src.repo}/${branch}/${id}/SKILL.md`,
    `https://cdn.jsdelivr.net/gh/${src.repo}@${branch}/${id}/SKILL.md`,
  ];
  let lastErr: Error | null = null;
  for (const url of candidates) {
    try {
      return await fetchText(url);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error('all skill mirrors failed');
}

/** 把内存里某个 source 的 index 持久化 */
function saveIndex(sourceId: string): void {
  fs.mkdirSync(sourceDir(sourceId), { recursive: true });
  const list = memIndex[sourceId] ?? [];
  fs.writeFileSync(indexFile(sourceId), JSON.stringify(list, null, 2), 'utf-8');
}

/** 用户上传的本地 skill 也归入索引,虚拟 source id = "local"。
 *  不需要在 config.agentSkills.sources 里登记 — 自动从 userData/skills/local/*.md 扫出来。 */
export const LOCAL_SOURCE_ID = 'local';

/** 内置 skill 虚拟 source id = "builtin"。
 *  不进 config.agentSkills.sources,文件打包在 app/electron/builtin-skills/*.md,
 *  每条有固定 metadata(name / description)用于 UI 展示。 */
export const BUILTIN_SOURCE_ID = 'builtin';

/** 内置 skill 目录。开发时是项目源码目录,打包后是 asar 内部路径。 */
function builtinDir(): string {
  return path.join(app.getAppPath(), 'electron', 'builtin-skills');
}

/** 内置 skill 元信息目录 — 决定了 UI 列表顺序和显示名。
 *  添加新 skill 时:写 md + 在此数组追加条目。 */
interface BuiltinMeta {
  rawId: string;
  name: string;
  description: string;
}
export const BUILTIN_CATALOG: BuiltinMeta[] = [
  {
    rawId: 'superpowers',
    name: 'SuperPowers',
    description: '元 skill — 先讨论再动手、做减法、自我批评、清单驱动。',
  },
  {
    rawId: 'planning-with-files',
    name: 'Planning with Files',
    description: '用 progress.md / plan.md 管理长任务,跨 session 不丢上下文。',
  },
  {
    rawId: 'ui-ux-pro-max',
    name: 'UI/UX Pro Max',
    description: 'UI/UX 设计智能 — 风格、调色板、字体搭配、现代组件栈。',
  },
  {
    rawId: 'code-review',
    name: 'Code Review',
    description: '系统性代码审查 — bug / 可维护性 / 性能 / 安全四视角。',
  },
  {
    rawId: 'code-simplifier',
    name: 'Code Simplifier',
    description: '简化过度设计的代码,降低圈复杂度,提取抽象。',
  },
  {
    rawId: 'webapp-testing',
    name: 'Webapp Testing',
    description: '基于 Playwright 的端到端测试方法论 + selector 稳定性。',
  },
  {
    rawId: 'ralph-loop',
    name: 'Ralph Loop',
    description: '循环执行直到目标满足的 agent 模式 — 自我修正、收敛判据。',
  },
  {
    rawId: 'mcp-builder',
    name: 'MCP Builder',
    description: '构建 Model Context Protocol server 的完整指南。',
  },
  {
    rawId: 'pptx',
    name: 'PPTX',
    description: '用 python-pptx 生成专业 PPT — 版式、字体、图表、母版。',
  },
  {
    rawId: 'skill-creator',
    name: 'Skill Creator',
    description: '教 AI 如何写 SKILL.md,自我扩展新能力。',
  },
  {
    rawId: 'soulbanner',
    name: 'SoulBanner / 万魂幡总入口',
    description: 'SoulBanner 角色路由入口:列出角色、按分类浏览、推荐或切换 persona。',
  },
  {
    rawId: 'soulbanner-categories',
    name: 'SoulBanner / 分类索引',
    description: 'SoulBanner 分类标签说明:abstract/business/fiction/jianghu/renhuang/research。',
  },
  {
    rawId: 'soulbanner-changshu-arno',
    name: 'SoulBanner / 常熟阿诺',
    description: '常熟阿诺视角:抽象表达、逻辑跳跃、真诚困惑与伪哲理感。',
  },
  {
    rawId: 'soulbanner-hanli',
    name: 'SoulBanner / 韩立',
    description: '韩立视角:谨慎求生、谋定后动、风险控制与长期存活。',
  },
  {
    rawId: 'soulbanner-huchenfeng',
    name: 'SoulBanner / 户晨风',
    description: '户晨风公开形象:短视频/直播表达风格、梗点与常用比喻。',
  },
  {
    rawId: 'soulbanner-liangzi',
    name: 'SoulBanner / 良子',
    description: '良子视角:草根吃播、体感、生猛、直给与强生存感。',
  },
  {
    rawId: 'soulbanner-tong-jincheng',
    name: 'SoulBanner / 童锦程',
    description: '童锦程视角:关系判断、直接、自嘲、反鸡汤与江湖式情感拆解。',
  },
  {
    rawId: 'soulbanner-yann-lecun',
    name: 'SoulBanner / Yann LeCun',
    description: 'Yann LeCun 视角:自监督学习、世界模型、反 hype 与智能系统思考。',
  },
  {
    rawId: 'soulbanner-yu-dazui',
    name: 'SoulBanner / 余大嘴',
    description: '余大嘴视角:商战发布会、产品话术、竞争姿态与品牌气势。',
  },
  {
    rawId: 'soulbanner-zhoulifeng',
    name: 'SoulBanner / 周丽峰',
    description: '周丽峰公开形象:口头禅、名场面与幽默表达模板。',
  },
  {
    rawId: 'soulbanner-musk',
    name: 'SoulBanner / 马斯克',
    description: '马斯克视角:第一性原理、产品执念、未来叙事与高压推进。',
  },
  {
    rawId: 'soulbanner-trump',
    name: 'SoulBanner / 特朗普',
    description: '特朗普视角:强叙事、夸张、对抗、绝对化表达与个人品牌中心。',
  },
  {
    rawId: 'soulbanner-zhang-xuefeng',
    name: 'SoulBanner / 张雪峰',
    description: '张雪峰视角:升学职业决策、就业导向、现实约束与直给判断。',
  },
];

/** 用 BUILTIN_CATALOG 构造 SkillEntry 列表,不依赖文件系统扫描 —
 *  metadata 是固定的,缺失的 md 文件在 getSkill 时才会报错。 */
function scanBuiltinSkills(): SkillEntry[] {
  return BUILTIN_CATALOG.map((m) => ({
    id: `${BUILTIN_SOURCE_ID}:${m.rawId}`,
    sourceId: BUILTIN_SOURCE_ID,
    rawId: m.rawId,
    name: m.name,
    cached: true,
  }));
}

/** 列出所有内置 skill 及其当前启用状态(给设置面板用)。 */
export function listBuiltinSkills(): Array<BuiltinMeta & { enabled: boolean }> {
  const cfg = loadConfig();
  const whitelisted = new Set(cfg.agentSkills?.builtinEnabled ?? []);
  return BUILTIN_CATALOG.map((m) => ({ ...m, enabled: whitelisted.has(m.rawId) }));
}

/** 扫描 local 目录,把 *.md 文件作为 skill 加入索引 */
function scanLocalSkills(): SkillEntry[] {
  const dir = sourceDir(LOCAL_SOURCE_ID);
  try {
    const files = fs.readdirSync(dir);
    return files
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => {
        const rawId = f.replace(/\.md$/i, '');
        return {
          id: `${LOCAL_SOURCE_ID}:${rawId}`,
          sourceId: LOCAL_SOURCE_ID,
          rawId,
          name: rawId,
          cached: true,
        };
      });
  } catch {
    return [];
  }
}

/** 启动时同步从磁盘恢复每个 source 的 index */
export function loadCachedSkillsIndex(): void {
  memIndex = {};
  try {
    const cfg = loadConfig();
    const sources = cfg.agentSkills?.sources ?? [];
    for (const src of sources) {
      try {
        const json = fs.readFileSync(indexFile(src.id), 'utf-8');
        const arr = JSON.parse(json);
        if (Array.isArray(arr)) memIndex[src.id] = arr;
      } catch {
        memIndex[src.id] = [];
      }
    }
    // local 源 — 直接扫文件系统,不依赖 index.json
    memIndex[LOCAL_SOURCE_ID] = scanLocalSkills();
    // builtin 源 — 用固定 catalog,不扫文件(避免目录缺失时整个挂掉)
    memIndex[BUILTIN_SOURCE_ID] = scanBuiltinSkills();
  } catch {
    memIndex = {};
  }
}

/** 异步从 GitHub 同步所有启用的 source 的 skill 列表(只拉子目录名)。
 *  网络失败时不报错,使用本地缓存。 */
export async function syncSkillsIndex(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.agentSkills?.enabled) return;
  const sources = cfg.agentSkills.sources.filter((s) => s.enabled);
  await Promise.allSettled(sources.map((src) => syncOneSource(src)));
}

async function syncOneSource(src: AgentSkillSource): Promise<void> {
  const branch = src.branch || 'main';
  // 试两个常见路径:`skills/`(addyosmani 风格)和根目录(qiushi 风格可能用根)
  const candidates = [
    `https://api.github.com/repos/${src.repo}/contents/skills?ref=${branch}`,
    `https://api.github.com/repos/${src.repo}/contents/?ref=${branch}`,
  ];
  for (const apiUrl of candidates) {
    try {
      const json = await fetchText(apiUrl);
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) continue;
      const dirs = arr.filter(
        (x: { type?: string; name?: string }) =>
          x.type === 'dir' &&
          typeof x.name === 'string' &&
          // 排除明显不是 skill 的目录(github 仓库根 contents 会含 .github / docs / images 等)
          !/^\.|^docs?$|^images?$|^assets?$|^scripts?$|^src$|^test/i.test(x.name),
      );
      if (dirs.length === 0) continue;
      const existing = memIndex[src.id] ?? [];
      const skills: SkillEntry[] = dirs.map((x: { name: string }) => {
        const old = existing.find((s) => s.rawId === x.name);
        return {
          id: `${src.id}:${x.name}`,
          sourceId: src.id,
          rawId: x.name,
          name: x.name,
          cached: old?.cached ?? false,
        };
      });
      memIndex[src.id] = skills;
      saveIndex(src.id);
      console.log(
        `[skill-registry] ${src.repo}: synced ${skills.length} skills (path: ${apiUrl.includes('skills?') ? 'skills/' : 'root'})`,
      );
      return;
    } catch (e) {
      // 试下一个 candidate
      void e;
    }
  }
  console.warn(`[skill-registry] ${src.repo}: sync failed for all paths (用本地缓存)`);
}

/** 列出所有启用 source 下的 skill(含本地上传的 local 源)。 */
export function listSkills(): SkillEntry[] {
  const cfg = loadConfig();
  if (!cfg.agentSkills?.enabled) return [];
  const sources = cfg.agentSkills.sources.filter((s) => s.enabled);
  const out: SkillEntry[] = [];
  for (const src of sources) {
    const list = memIndex[src.id] ?? [];
    out.push(...list);
  }
  // local:总开关开就包含,但过滤掉用户单独禁用的(localDisabled)
  const localDisabled = new Set(cfg.agentSkills.localDisabled ?? []);
  for (const s of memIndex[LOCAL_SOURCE_ID] ?? []) {
    if (!localDisabled.has(s.rawId)) out.push(s);
  }
  // builtin:默认全关,只有在 builtinEnabled 白名单里的才包含
  const builtinEnabled = new Set(cfg.agentSkills.builtinEnabled ?? []);
  for (const s of memIndex[BUILTIN_SOURCE_ID] ?? []) {
    if (builtinEnabled.has(s.rawId)) out.push(s);
  }
  return out;
}

// ===== 本地 skill 管理 — 用户从设置面板上传的 SKILL.md =====

/** 把一段 markdown 内容保存为一条本地 skill。返回新 entry。
 *  rawName 已存在则覆盖。 */
export function addLocalSkill(rawName: string, content: string): SkillEntry {
  const safe = safeName(rawName);
  if (!safe) throw new Error('invalid skill name');
  if (!content || !content.trim()) throw new Error('skill content empty');
  const dir = sourceDir(LOCAL_SOURCE_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, safe + '.md'), content, 'utf-8');
  // 重新扫一下保持索引最新
  memIndex[LOCAL_SOURCE_ID] = scanLocalSkills();
  return {
    id: `${LOCAL_SOURCE_ID}:${safe}`,
    sourceId: LOCAL_SOURCE_ID,
    rawId: safe,
    name: safe,
    cached: true,
  };
}

/** 删除一条本地 skill,按 rawId(文件名,无扩展名)。返回是否成功。 */
export function removeLocalSkill(rawName: string): boolean {
  const safe = safeName(rawName);
  if (!safe) return false;
  const file = path.join(sourceDir(LOCAL_SOURCE_ID), safe + '.md');
  try {
    fs.unlinkSync(file);
    memIndex[LOCAL_SOURCE_ID] = scanLocalSkills();
    return true;
  } catch {
    return false;
  }
}

/** 列出所有本地 skill(给设置面板用)。 */
export function listLocalSkills(): SkillEntry[] {
  return memIndex[LOCAL_SOURCE_ID] ?? [];
}

/** 列出已经缓存到本机的在线 skill。
 *  这些通常是 AI 通过 query_skill 首次读取后下载到 userData/skills/<source>/*.md 的内容。
 *  不包含 local / builtin,只用于设置面板展示"AI 已经下载过哪些在线 skill"。 */
export function listDownloadedSkills(): SkillEntry[] {
  const cfg = loadConfig();
  const sources = cfg.agentSkills?.sources ?? [];
  const out: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const src of sources) {
    const list = memIndex[src.id] ?? [];
    for (const s of list) {
      const file = path.join(sourceDir(src.id), safeName(s.rawId) + '.md');
      if (!s.cached && !fs.existsSync(file)) continue;
      const id = `${src.id}:${s.rawId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...s, id, sourceId: src.id, cached: true });
    }

    try {
      const files = fs.readdirSync(sourceDir(src.id));
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        const rawId = f.replace(/\.md$/i, '');
        const id = `${src.id}:${rawId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const old = list.find((s) => s.rawId === rawId);
        out.push({
          id,
          sourceId: src.id,
          rawId,
          name: old?.name ?? rawId,
          cached: true,
        });
      }
    } catch {
      // source 还没有任何缓存文件
    }
  }

  return out.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.rawId.localeCompare(b.rawId));
}

/** 获取某个 skill 的完整 markdown。先看本地缓存,没有就 fetch + 缓存。
 *  fqId = "addyosmani:react"。返回的内容已截断到 12KB。 */
export async function getSkill(fqId: string): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.agentSkills?.enabled) {
    throw new Error('agentSkills is disabled in settings');
  }
  const parsed = parseFqId(fqId);
  if (!parsed) {
    // 容错:如果 AI 没加前缀,尝试在所有 source 里找到第一个匹配的 rawId
    const found = listSkills().find((s) => s.rawId === fqId);
    if (!found) throw new Error(`skill not found: ${fqId} (id 格式应为 "<source>:<name>")`);
    return getSkill(found.id);
  }
  const { sourceId, rawId } = parsed;
  const safeRaw = safeName(rawId);
  if (!safeRaw) throw new Error('invalid skill id');

  // local 源:直接从用户上传的文件读,不需要网络
  if (sourceId === LOCAL_SOURCE_ID) {
    const file = path.join(sourceDir(LOCAL_SOURCE_ID), safeRaw + '.md');
    try {
      return capContent(fs.readFileSync(file, 'utf-8'));
    } catch {
      throw new Error(`local skill not found: ${safeRaw}`);
    }
  }

  // builtin 源:读打包内的 md 文件,并校验用户白名单
  if (sourceId === BUILTIN_SOURCE_ID) {
    const builtinEnabled = new Set(cfg.agentSkills.builtinEnabled ?? []);
    if (!builtinEnabled.has(safeRaw)) {
      throw new Error(`builtin skill not enabled: ${safeRaw}(请到设置 → Agent Skills 开启)`);
    }
    const file = path.join(builtinDir(), safeRaw + '.md');
    try {
      return capContent(fs.readFileSync(file, 'utf-8'));
    } catch {
      throw new Error(`builtin skill md missing: ${safeRaw}`);
    }
  }

  const src = cfg.agentSkills.sources.find((s) => s.id === sourceId && s.enabled);
  if (!src) throw new Error(`source "${sourceId}" not enabled or not found`);

  const file = path.join(sourceDir(sourceId), safeRaw + '.md');
  try {
    const cached = fs.readFileSync(file, 'utf-8');
    const entry = (memIndex[sourceId] ?? []).find((s) => s.rawId === safeRaw);
    if (entry && !entry.cached) {
      entry.cached = true;
      saveIndex(sourceId);
    }
    return capContent(cached);
  } catch {
    // 没缓存,继续 fetch
  }
  const md = await fetchSkillMd(src, safeRaw);
  fs.mkdirSync(sourceDir(sourceId), { recursive: true });
  fs.writeFileSync(file, md, 'utf-8');
  // 标记 cached
  const entry = (memIndex[sourceId] ?? []).find((s) => s.rawId === safeRaw);
  if (entry) {
    entry.cached = true;
    saveIndex(sourceId);
  }
  appEvents.emitSkillsChanged('online-skill-downloaded', { id: `${sourceId}:${safeRaw}` });
  return capContent(md);
}

const CONTENT_CAP = 12_000;
function capContent(s: string): string {
  if (s.length <= CONTENT_CAP) return s;
  return s.slice(0, CONTENT_CAP) + '\n\n...(SKILL.md 太长,已截断到 12KB)';
}
