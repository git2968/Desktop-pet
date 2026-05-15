/**
 * 内置 tool — 不走 MCP 子进程,直接在主进程实现。
 * 让 AI 能"打开网页 / 打开应用 / 搜索 / 操作剪贴板 / 系统通知"等。
 *
 * 暴露统一接口:
 *  - listBuiltinTools()   → 返回 tool 描述列表(prefix 已加 "app__")
 *  - callBuiltinTool()    → 路由到对应 handler
 *  - isBuiltinTool()      → 判断 prefixedName 是否属于 builtin
 *  - isBuiltinMutating()  → 判断是否需要用户确认(打开 exe / 写剪贴板等)
 *
 * 与 McpManager 协同:McpManager.listAllTools 会合并 builtin + servers;callTool 先看是不是 builtin。
 */

import { shell, clipboard, Notification, app, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { addMemory, removeMemory, listMemories } from './memory-store.js';
import { listSkills, getSkill } from './skill-registry.js';
import { readScreenElements } from './uia-reader.js';
import { loadConfig } from './config-store.js';
import { appEvents } from './app-events.js';

// ---- prefix ----
const APP_PREFIX = 'app';

// ---- tool 定义 ----
interface BuiltinTool {
  /** 不带前缀,如 'open_url' */
  rawName: string;
  description: string;
  /** OpenAI function 兼容的 JSON Schema */
  inputSchema: Record<string, unknown>;
  /** true = 需要用户二次确认才执行(危险 / 副作用大) */
  mutating: boolean;
  /** 实际执行函数,返回字符串(给 LLM 看)或抛错 */
  handler: (args: Record<string, unknown>) => Promise<string> | string;
}

const TOOLS: BuiltinTool[] = [
  // ---------- 浏览器 / URL ----------
  {
    rawName: 'open_url',
    description:
      '在用户默认浏览器中打开一个 URL(http/https/file 等)。不会等待用户行为。' +
      '比如打开网页、文档、本地 HTML 等。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL,例如 https://example.com' },
      },
      required: ['url'],
    },
    mutating: false,
    handler: async (a) => {
      const url = String(a.url ?? '').trim();
      if (!url) throw new Error('url is required');
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
        throw new Error('url must include scheme (http://, https://, file://, etc)');
      }
      await shell.openExternal(url);
      return `Opened ${url} in default browser.`;
    },
  },

  // ---------- 搜索 ----------
  {
    rawName: 'web_search',
    description:
      '用搜索引擎搜一个关键词,**在用户的默认浏览器里打开搜索结果页**。' +
      '⚠ 你看不到搜索结果(本工具不会把网页内容返回给你),它只是替用户打开浏览器搜索页。' +
      '所以如果用户希望你「告诉他答案」「给他总结」,这个工具帮不上;只有用户明确说「帮我搜一下」「打开搜索」时才调用。' +
      'engine 可选: bing(默认) / google / baidu / duckduckgo。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        engine: {
          type: 'string',
          enum: ['bing', 'google', 'baidu', 'duckduckgo'],
          description: '搜索引擎,默认 bing',
        },
      },
      required: ['query'],
    },
    mutating: false,
    handler: async (a) => {
      const q = String(a.query ?? '').trim();
      if (!q) throw new Error('query is required');
      const engine = String(a.engine ?? 'bing').toLowerCase();
      const enc = encodeURIComponent(q);
      const map: Record<string, string> = {
        bing: `https://www.bing.com/search?q=${enc}`,
        google: `https://www.google.com/search?q=${enc}`,
        baidu: `https://www.baidu.com/s?wd=${enc}`,
        duckduckgo: `https://duckduckgo.com/?q=${enc}`,
      };
      const url = map[engine] ?? map.bing;
      await shell.openExternal(url);
      return `Opened ${engine} search for: ${q}`;
    },
  },

  // ---------- 文件 / 应用 ----------
  {
    rawName: 'open_path',
    description:
      '用系统默认程序「启动」一个本地文件 / 文件夹 / 可执行文件(等同于双击)。' +
      '⚠ 注意:这只是把它交给资源管理器/默认程序去打开窗口,**不是读取内容**。' +
      '如果用户说「看看 / 读 / 查看 / 检查 / 分析 / 总结」一个文件或目录的「内容」,' +
      '请使用 filesystem MCP server 的 read_file / read_text_file / list_directory / directory_tree 等工具,' +
      '而不要用这个 open_path。' +
      '只有用户明确说「打开 / 启动 / 跑 / 运行 / 在资源管理器里看」时才用 open_path。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径' },
      },
      required: ['path'],
    },
    mutating: true,
    handler: async (a) => {
      const p = String(a.path ?? '').trim();
      if (!p) throw new Error('path is required');
      if (!fs.existsSync(p)) throw new Error(`path not found: ${p}`);
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
      return `Opened ${p}`;
    },
  },
  {
    rawName: 'list_installed_apps',
    description:
      '列出系统已安装应用(从开始菜单/Applications 文件夹扫 .lnk / .app)。可选 keyword 做模糊筛选。' +
      '返回应用名 + 启动路径列表。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '名字模糊匹配关键词,留空则全部' },
        limit: { type: 'number', description: '最多返回多少条,默认 50' },
      },
    },
    mutating: false,
    handler: async (a) => {
      const apps = listInstalledApps();
      const kw = String(a.keyword ?? '').toLowerCase().trim();
      const limit = typeof a.limit === 'number' ? a.limit : 50;
      const filtered = kw ? apps.filter((x) => x.name.toLowerCase().includes(kw)) : apps;
      const top = filtered.slice(0, limit);
      if (top.length === 0) return 'No installed apps matched.';
      return top.map((x) => `${x.name}\t${x.path}`).join('\n');
    },
  },
  {
    rawName: 'open_app',
    description:
      '按名字模糊匹配并启动一个已安装应用(优先开始菜单/Applications)。' +
      '比如 "vscode" / "微信" / "chrome"。⚠ 真启动程序,需要确认。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '应用名(模糊匹配)' },
      },
      required: ['name'],
    },
    mutating: true,
    handler: async (a) => {
      const name = String(a.name ?? '').toLowerCase().trim();
      if (!name) throw new Error('name is required');
      const apps = listInstalledApps();
      const hit = apps.find((x) => x.name.toLowerCase() === name)
        ?? apps.find((x) => x.name.toLowerCase().includes(name));
      if (!hit) throw new Error(`no installed app matched: ${name}`);
      const err = await shell.openPath(hit.path);
      if (err) throw new Error(err);
      return `Launched: ${hit.name} (${hit.path})`;
    },
  },

  // ---------- 剪贴板 ----------
  {
    rawName: 'get_clipboard',
    description: '读取系统剪贴板的文本内容。',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: () => {
      const t = clipboard.readText();
      return t || '(clipboard is empty)';
    },
  },
  {
    rawName: 'set_clipboard',
    description: '写入文本到系统剪贴板(覆盖原内容)。⚠ 修改剪贴板,需要确认。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入的文本' },
      },
      required: ['text'],
    },
    mutating: true,
    handler: (a) => {
      const t = String(a.text ?? '');
      clipboard.writeText(t);
      return `Set clipboard (${t.length} chars).`;
    },
  },

  // ---------- 通知 ----------
  {
    rawName: 'notify',
    description: '弹一个系统级桌面通知(右下角 toast)。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题' },
        body: { type: 'string', description: '正文(可选)' },
      },
      required: ['title'],
    },
    mutating: false,
    handler: (a) => {
      const title = String(a.title ?? '').trim();
      if (!title) throw new Error('title is required');
      const body = String(a.body ?? '');
      if (!Notification.isSupported()) {
        throw new Error('system notifications not supported on this platform');
      }
      new Notification({ title, body }).show();
      return `Sent notification: ${title}`;
    },
  },

  // ---------- 时间 ----------
  {
    rawName: 'get_current_time',
    description:
      '返回当前本地时间 + ISO + 时区 + 星期 + Unix 时间戳。AI 不知道"今天是几号 / 现在几点"时调用这个。',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return JSON.stringify(
        {
          local: now.toLocaleString('zh-CN', { hour12: false }),
          iso: now.toISOString(),
          timezone: tz,
          weekday: weekdays[now.getDay()],
          unix_ms: now.getTime(),
        },
        null,
        2,
      );
    },
  },

  // ---------- 文件读取 — 用户让"看 / 读 / 分析 / 总结"文件时用 ----------
  {
    rawName: 'read_text_file',
    description:
      '读取一个本地文本文件的内容(代码、配置、文档等)并返回字符串。' +
      '用户说「看看 / 读 / 查看 / 分析 / 总结 / 解释」一个具体文件的内容时调这个,**不要**用 app__open_path(那只是启动外部程序窗口)。' +
      '⚠ 安全:仅返回文本(检测到二进制会拒绝)。最多读取 256KB,超过会截断。' +
      '用户会看到一个"AI 想读取 X 文件"的确认弹窗,点允许才会真读。' +
      '路径要绝对路径(Windows 形如 D:\\\\path\\\\to\\\\file.ts,Unix 形如 /home/user/file.txt)。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
      },
      required: ['path'],
    },
    mutating: true, // 走用户确认 — 读文件涉及隐私
    handler: (args) => {
      const p = String(args.path ?? '').trim();
      if (!p) return JSON.stringify({ error: 'path required' });
      try {
        const stat = fs.statSync(p);
        if (!stat.isFile()) return JSON.stringify({ error: `不是文件: ${p}` });
        if (stat.size > 256 * 1024) {
          // 大文件只读前 256KB
          const fd = fs.openSync(p, 'r');
          const buf = Buffer.alloc(256 * 1024);
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          // 检测二进制
          if (buf.includes(0)) {
            return JSON.stringify({ error: `${p} 看起来是二进制文件,无法当文本读取` });
          }
          return buf.toString('utf-8') + `\n\n...(文件 ${stat.size} 字节,只读了前 256KB)`;
        }
        const buf = fs.readFileSync(p);
        if (buf.includes(0)) {
          return JSON.stringify({ error: `${p} 看起来是二进制文件,无法当文本读取` });
        }
        return buf.toString('utf-8');
      } catch (e) {
        return JSON.stringify({ error: `读取失败:${(e as Error).message}` });
      }
    },
  },
  {
    rawName: 'list_directory',
    description:
      '列出一个本地目录下的所有文件和子目录(只列一层,不递归)。' +
      '用户说「看看这个项目 / 文件夹有什么 / 目录结构」时调这个。' +
      '返回 JSON 数组,每项含 name / type(file/dir)/ size。' +
      '⚠ 用户会看到"AI 想读取 X 目录"确认弹窗,点允许才会真读。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径' },
      },
      required: ['path'],
    },
    mutating: true,
    handler: (args) => {
      const p = String(args.path ?? '').trim();
      if (!p) return JSON.stringify({ error: 'path required' });
      try {
        const stat = fs.statSync(p);
        if (!stat.isDirectory()) return JSON.stringify({ error: `不是目录: ${p}` });
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const result = entries.slice(0, 500).map((e) => {
          const full = path.join(p, e.name);
          let size = 0;
          try {
            size = e.isFile() ? fs.statSync(full).size : 0;
          } catch {
            // ignore
          }
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
            size,
          };
        });
        return JSON.stringify(
          {
            path: p,
            count: entries.length,
            truncated: entries.length > 500,
            entries: result,
          },
          null,
          2,
        );
      } catch (e) {
        return JSON.stringify({ error: `列目录失败:${(e as Error).message}` });
      }
    },
  },

  // ---------- 屏幕元素读取(Windows UI Automation)----------
  {
    rawName: 'read_screen_elements',
    description:
      '读取当前【前景窗口】的所有可见 UI 控件(像屏幕阅读器那样)。会自动跳过桌宠自己的窗口,读用户真正在看的应用。' +
      '返回 JSON:{ windowTitle, processName, elements: [{ name, type, x, y, w, h, depth, enabled, selected }] }。' +
      '⚠ 仅 Windows 可用(底层走 PowerShell + .NET UIAutomation)。' +
      '⚠ 用户会看到"AI 想读屏幕内容"确认弹窗,允许后才真读。' +
      '使用场景:' +
      '  - 用户问"我屏幕上现在显示什么 / 我在写什么 / 帮我看看这个软件 / 这个网页讲什么 / 看看这个网页"' +
      '  - 需要知道用户当前在用哪个应用 / 哪个文件 / 选中了什么标签' +
      '  - 屏幕上有错误对话框需要解读' +
      '浏览器(Chrome / Edge / Firefox)也能读:页面正文出现在 type=Document / Text / Hyperlink 等元素里;首次读取浏览器时 a11y 树可能还在加载,内容偏少,可隔几秒再调一次。' +
      '相比截图的优势:拿到的是结构化文本(控件名 / 类型 / 位置),token 省、不需要 vision 模型。' +
      '注意:只能拿到前景(当前激活)窗口,不能拿后台的或多屏的。',
    inputSchema: { type: 'object', properties: {} },
    mutating: true, // 屏幕内容含隐私,每次走用户确认
    handler: async () => {
      try {
        const snap = await readScreenElements();
        // 控件量大时截断 elements 数组,prompt 不要太长
        const MAX = 200;
        const trimmed = snap.elements.slice(0, MAX);
        return JSON.stringify(
          {
            windowTitle: snap.windowTitle,
            processName: snap.processName,
            elementsCount: snap.elements.length,
            elementsShown: trimmed.length,
            elements: trimmed,
            note: snap.elements.length > MAX
              ? `仅返回前 ${MAX} 个控件(共 ${snap.elements.length})`
              : undefined,
          },
          null,
          2,
        );
      } catch (e) {
        return JSON.stringify({ error: `读取屏幕失败:${(e as Error).message}` });
      }
    },
  },

  // ---------- 屏幕文字 OCR(Windows 内置 Windows.Media.Ocr)----------
  {
    rawName: 'read_screen_text',
    description:
      '截取整个屏幕并用 Windows 内置 OCR 识别文字。' +
      '完全本地、不上网、免费,中英文识别质量高,无需任何 API key。' +
      '⚠ 仅 Windows 可用。' +
      '⚠ 用户会看到"AI 想读屏幕内容"确认弹窗(除非在「主动互动」里开了"自动读屏")。' +
      '⚠ 这个工具在 read_screen_elements 读不到时使用 — 也就是 Electron / CEF / 自绘界面应用,' +
      '例如 B站客户端、QQ、微信、抖音、网易云音乐、各种小程序等(它们的内部界面 UIA 看不到)。' +
      '常规 Win32 程序(资源管理器、记事本、Word)优先用 read_screen_elements,因为有结构化信息。' +
      '返回 JSON:{ text }。text 是整屏识别到的所有文字(行间用 \\n 分隔)。' +
      '注意:不识别图标 / 图像内容(看不出"图里那个人是谁"),只能拿文字。如果用户要识别图像,告诉用户切换支持视觉的模型。',
    inputSchema: { type: 'object', properties: {} },
    mutating: true, // 屏幕内容含隐私,每次走用户确认(autoReadScreen 时 ai-client 会旁路)
    handler: async () => {
      try {
        const { captureScreenAndOcr } = await import('./windows-ocr.js');
        const { text } = await captureScreenAndOcr();
        // 太长截断 — OCR 整屏可能上万字,LLM 看不动
        const MAX = 8000;
        const trimmed = text.length > MAX ? text.slice(0, MAX) + '\n\n…(已截断)' : text;
        return JSON.stringify({
          text: trimmed,
          length: text.length,
          note: text.length > MAX ? `仅返回前 ${MAX} 字符(共 ${text.length})` : undefined,
        });
      } catch (e) {
        return JSON.stringify({ error: `OCR 失败:${(e as Error).message}` });
      }
    },
  },

  // ---------- 长期记忆 — 跨会话 / 跨模型 ----------
  {
    rawName: 'remember',
    description:
      '把一条信息写入用户的长期记忆(跨会话、跨模型,任何对话都会看到)。' +
      '触发场景:用户说「记住 X」「记一下 X」「我以后都...」「我喜欢 / 不喜欢 X」「我的 X 是 Y」' +
      '等明确想让你长期保留的事情。' +
      '⚠ 一次只写一条简洁陈述句(不超过 80 字),不要把一整段对话扔进来。' +
      '已存在相同内容的条目则不重复,只刷新时间戳。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '要记住的事实陈述。简洁、可独立读懂(不依赖上下文)。',
        },
      },
      required: ['content'],
    },
    mutating: false, // 写本地文件,不弹外部确认
    handler: (args) => {
      const content = String(args.content ?? '').trim();
      if (!content) return JSON.stringify({ error: 'content required' });
      const m = addMemory(content);
      return JSON.stringify({ ok: true, id: m.id, content: m.content });
    },
  },
  {
    rawName: 'forget',
    description:
      '删除一条已记住的内容。参数 match 可以是记忆条目的 id,或者条目内容里的关键片段(子串匹配)。' +
      '触发场景:用户说「忘掉 X」「别记着 X 了」「我说错了」等。' +
      '不确定 id 时直接传内容关键词即可。',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: '记忆 id 或内容关键词' },
      },
      required: ['match'],
    },
    mutating: false,
    handler: (args) => {
      const match = String(args.match ?? '').trim();
      if (!match) return JSON.stringify({ error: 'match required' });
      const removed = removeMemory(match);
      return JSON.stringify({ ok: true, removed });
    },
  },
  {
    rawName: 'list_memories',
    description:
      '列出当前所有长期记忆条目。一般你不需要主动调 — 系统已经在 system prompt 里给你看了。' +
      '只有在用户明确问「我让你记过什么 / 你记得我哪些事」时才调。',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: () => {
      const list = listMemories();
      return JSON.stringify(
        list.map((m) => ({
          id: m.id,
          content: m.content,
          created: new Date(m.createdAt).toISOString(),
        })),
        null,
        2,
      );
    },
  },

  // ---------- Agent Skills(SKILL.md 知识库) ----------
  {
    rawName: 'list_skills',
    description:
      '列出当前装备的所有 SKILL.md(在线源、本地上传、内置 skill)。' +
      '每个 skill 是一个可按需读取的专题参考,可能是编程指南、写作方法、角色 persona 或其它能力模块。' +
      '⚠ 用户问题可能命中某个 skill 时,**先调这个**看有没有相关 skill。' +
      '若有,再调 app__query_skill(skill_id="...") 拿详细 markdown 内容作为参考。' +
      '没有相关 skill 就照常用你自己的知识回答。',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: () => {
      const list = listSkills();
      if (list.length === 0) {
        return JSON.stringify({
          skills: [],
          note: 'skill 列表为空 — 可能是用户在设置里关闭了 agentSkills,或首次启动同步未完成,或网络访问 GitHub 失败。可仍然依靠你自己的知识回答用户。',
        });
      }
      // 按 source 分组返回,id 是全限定形式 "source:rawId"
      const bySource: Record<string, string[]> = {};
      for (const s of list) {
        if (!bySource[s.sourceId]) bySource[s.sourceId] = [];
        bySource[s.sourceId].push(s.id);
      }
      return JSON.stringify(
        { count: list.length, skills_by_source: bySource },
        null,
        2,
      );
    },
  },
  {
    rawName: 'query_skill',
    description:
      '获取一个 skill 的详细 markdown 内容(来自在线源、本地上传或内置 skill)。' +
      '先用 app__list_skills 看 id 列表,挑相关的调这个。' +
      'skill_id 用全限定形式 "<source>:<name>",例:query_skill(skill_id="builtin:soulbanner") / query_skill(skill_id="addyosmani:react")。' +
      '若 skill 不存在或网络失败会返回错误,此时不要重试,直接用你自己的知识回答。',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: 'skill 的 id(从 list_skills 的结果取,大小写敏感)',
        },
      },
      required: ['skill_id'],
    },
    mutating: false,
    handler: async (args) => {
      const id = String(args.skill_id ?? '').trim();
      if (!id) return JSON.stringify({ error: 'skill_id required' });
      try {
        const md = await getSkill(id);
        return md;
      } catch (e) {
        return JSON.stringify({ error: `获取 skill 失败:${(e as Error).message}` });
      }
    },
  },

  // ---------- 后台 HTTP 抓取 — 不打扰用户的浏览器 ----------
  {
    rawName: 'http_fetch',
    description:
      '后台 HTTP GET 一个 URL,把响应正文返回给你(纯文本/HTML/JSON)。' +
      '⚠ 不会打开用户的浏览器,完全在后台静默完成。' +
      '适合「看看新闻」「读这个网页内容」「拉个 JSON API」等场景。' +
      '响应被截断为前 60KB(防止 prompt 过长),如果是 HTML 已自动剥掉 script/style/标签噪声。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL(http/https)' },
        as: {
          type: 'string',
          enum: ['auto', 'text', 'html-stripped', 'json'],
          description:
            "响应处理方式:auto(默认,按 content-type 判断;HTML 自动剥标签)、text(原样)、html-stripped(强制剥)、json(解析后再 stringify)",
        },
      },
      required: ['url'],
    },
    mutating: false,
    handler: async (a) => {
      const url = String(a.url ?? '').trim();
      const as = String(a.as ?? 'auto');
      if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)://...');
      const result = await httpGet(url);
      let body = result.body;
      const ct = result.contentType.toLowerCase();
      const wantStrip = as === 'html-stripped' || (as === 'auto' && /html/.test(ct));
      const wantJson = as === 'json' || (as === 'auto' && /json/.test(ct));
      if (wantJson) {
        try {
          body = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          // fall through, 用原文
        }
      } else if (wantStrip) {
        body = stripHtml(body);
      }
      const max = 60 * 1024;
      if (body.length > max) body = body.slice(0, max) + `\n\n…(已截断,原始 ${body.length} 字符)`;
      return `[${result.status}] ${result.contentType}\n\n${body}`;
    },
  },

  // ---------- 后台搜索 — 不打开浏览器 ----------
  {
    rawName: 'http_search',
    description:
      '后台搜索网页并把结果列表(标题 + URL + 摘要)返回给你。' +
      '⚠ 不会打开用户的浏览器,完全在后台。常用于「帮我看看最近的 X 新闻」「搜一下 Y 是什么」。' +
      '拿到结果列表后,应该再用 http_fetch 抓 1~3 条最相关链接的内容,综合回答用户。' +
      'engine 可选: bing(默认,国内可达) / duckduckgo / sogou。' +
      '一个引擎失败 / 拿不到结果时,自动 fallback 试下一个。' +
      '⚠ 关于"最新/最近": 你的训练数据有截止时间,system 里告诉了你今天的真实日期。' +
      '当用户问「最新/最近的 X」时,query **必须**带上当前年份(例:「2026 最新奥特曼」而不是「最新奥特曼」),' +
      '否则可能拿到旧索引页,把过时的内容当成"最新"返回给用户。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '最多返回结果数,默认 8,上限 20' },
        engine: {
          type: 'string',
          enum: ['bing', 'duckduckgo', 'sogou'],
          description: '搜索引擎,默认 bing(对国内网络更友好)',
        },
      },
      required: ['query'],
    },
    mutating: false,
    handler: async (a) => {
      const q = String(a.query ?? '').trim();
      if (!q) throw new Error('query is required');
      const limit = Math.min(Math.max(typeof a.limit === 'number' ? a.limit : 8, 1), 20);
      const preferred = String(a.engine ?? 'bing') as 'bing' | 'duckduckgo' | 'sogou';
      // 自动 fallback 链:从用户指定的开始,失败再试别的
      const order: Array<'bing' | 'duckduckgo' | 'sogou'> = ['bing', 'duckduckgo', 'sogou'];
      const tryList = [preferred, ...order.filter((e) => e !== preferred)];
      const errs: string[] = [];
      for (const eng of tryList) {
        try {
          const results = await searchEngine(eng, q, limit);
          if (results.length > 0) {
            return (
              `[engine=${eng}] ${results.length} results\n\n` +
              results
                .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
                .join('\n\n')
            );
          }
          errs.push(`${eng}: 0 results`);
        } catch (e) {
          errs.push(`${eng}: ${(e as Error).message}`);
        }
      }
      return `(all engines failed)\n${errs.join('\n')}`;
    },
  },

  // ---------- 保存文本到本地文件 — 不需要 fs server 也能给用户写总结 ----------
  {
    rawName: 'save_text_to_file',
    description:
      '把一段文本(Markdown / 纯文本 / JSON 等)保存到用户的 Downloads 目录,自动加时间戳防覆盖。' +
      '场景:用户问完一个问题让你"写个总结"「输出成 md」「保存成文件」时调这个,不需要先配 filesystem server。' +
      '保存后告诉用户文件路径,用户可以自己去打开。',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description:
            '建议的文件名(不要带绝对路径,只要文件名 + 后缀,如 "news-summary.md")',
        },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['filename', 'content'],
    },
    mutating: true,
    handler: async (a) => {
      const filename = String(a.filename ?? '').trim();
      const content = String(a.content ?? '');
      if (!filename) throw new Error('filename is required');
      // 防 path traversal
      const safe = path.basename(filename).replace(/[<>:"|?*\x00-\x1f]/g, '_');
      // 时间戳后缀避免覆盖
      const ext = path.extname(safe);
      const stem = ext ? safe.slice(0, -ext.length) : safe;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const finalName = `${stem}-${ts}${ext || '.txt'}`;
      const dir = app.getPath('downloads');
      const target = path.join(dir, finalName);
      fs.writeFileSync(target, content, 'utf-8');
      return `Saved ${content.length} chars to:\n${target}`;
    },
  },

  // ---------- 让 AI 自己看可装的 MCP server ----------
  {
    rawName: 'list_available_mcp_servers',
    description:
      '列出所有可以一键安装的 MCP server 模板(id / 描述 / 是否需要 API key 等)。' +
      '当你发现自己缺少某个能力(如 git 操作、SQL 查询、网页自动化等)时,先调这个看有没有现成的 server,再用 install_mcp_server 装。',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => {
      const { MCP_PRESETS } = await import('../shared/mcp-presets.js');
      const lines = MCP_PRESETS.filter((p) => p.id !== 'custom').map((p) => {
        const reqEnv = p.requiredEnv?.length
          ? `  required env: ${p.requiredEnv.join(', ')}`
          : '';
        const phold = p.argsPlaceholders?.length
          ? `  required args (replace placeholders): ${p.argsPlaceholders.join(', ')}`
          : '';
        return [`- id=${p.id}: ${p.description}`, reqEnv, phold]
          .filter(Boolean)
          .join('\n');
      });
      return lines.join('\n\n');
    },
  },

  // ---------- 让 AI 自己装 MCP server(用户最终在 confirm 弹框里点允许) ----------
  {
    rawName: 'install_mcp_server',
    description:
      '把指定的 MCP server preset 加到用户配置里并立即启动,之后这个 server 提供的所有 tool 你就能调用了。' +
      '⚠ 用户会看到一个安装确认弹窗(显示要装什么、要调什么命令),用户点允许后才真的装。' +
      '需要 env(如 API key)或 args 占位符替换的 server,要把对应字段填好;不填则后续用户得手工补。' +
      '装完会等几秒让 server 启动,然后返回新可用的 tool 列表给你。',
    inputSchema: {
      type: 'object',
      properties: {
        preset_id: {
          type: 'string',
          description: '从 list_available_mcp_servers 拿到的 id,例如 fs / memory / fetch / git',
        },
        env: {
          type: 'object',
          description: '环境变量覆盖,如 { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxx" }',
          additionalProperties: { type: 'string' },
        },
        args_replacements: {
          type: 'object',
          description:
            'args 中占位符替换,如 { "<改成仓库路径>": "D:/Code/myrepo" }。键要和占位符完全一致。',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['preset_id'],
    },
    mutating: true,
    handler: async (a) => {
      const presetId = String(a.preset_id ?? '').trim();
      const envOverride = (a.env && typeof a.env === 'object' ? a.env : {}) as Record<
        string,
        string
      >;
      const replacements = (a.args_replacements && typeof a.args_replacements === 'object'
        ? a.args_replacements
        : {}) as Record<string, string>;
      const { MCP_PRESETS } = await import('../shared/mcp-presets.js');
      const { loadConfig, saveConfig } = await import('./config-store.js');
      const { mcpManager } = await import('./mcp-client.js');
      const preset = MCP_PRESETS.find((p) => p.id === presetId);
      if (!preset) throw new Error(`unknown preset_id: ${presetId}`);
      const cfg = loadConfig();
      const existing = cfg.mcp?.servers ?? [];
      // 生成唯一 id
      const used = new Set(existing.map((s) => s.id));
      let newId = preset.id;
      let i = 2;
      while (used.has(newId)) newId = `${preset.id}${i++}`;
      // args 占位符替换
      const args = preset.template.args.map((arg) => replacements[arg] ?? arg);
      // 检查必填占位符是否全填
      const stillPlaceholder = args.filter((x) => /^<.+>$/.test(x));
      if (stillPlaceholder.length > 0) {
        throw new Error(
          `还有占位符未替换: ${stillPlaceholder.join(', ')}。请重新调用并在 args_replacements 里给出值。`,
        );
      }
      // env 合并(必填 env 校验)
      const env = { ...(preset.template.env ?? {}), ...envOverride };
      const missingEnv = (preset.requiredEnv ?? []).filter((k) => !env[k]);
      if (missingEnv.length > 0) {
        throw new Error(
          `必填 env 缺失: ${missingEnv.join(', ')}。请告诉用户去申请,然后重新调用本工具并在 env 里填上。`,
        );
      }
      const newSpec = {
        id: newId,
        name: preset.template.name,
        enabled: true,
        command: preset.template.command,
        args,
        env: Object.keys(env).length > 0 ? env : undefined,
      };
      const nextMcp = {
        enabled: cfg.mcp?.enabled !== false,
        servers: [...existing, newSpec],
        confirmWrites: cfg.mcp?.confirmWrites !== false,
      };
      saveConfig({ mcp: nextMcp });
      // 立即应用(异步启动 server)
      await mcpManager.applyConfig(nextMcp);
      appEvents.emitConfigChanged('mcp-installed-by-ai', { serverId: newId });
      // 等 server 起来一点,再列 tools
      await new Promise((r) => setTimeout(r, 1500));
      const allTools = await mcpManager.listAllTools();
      const newTools = allTools.filter((t) => t.serverId === newId);
      if (newTools.length === 0) {
        return `Installed "${newId}" but it didn't expose any tool yet (可能还在启动 / 缺依赖)。请告诉用户在终端看一眼有没有错误,或者过几秒再问我。`;
      }
      return (
        `Installed "${newId}" (${preset.template.name})。新增 ${newTools.length} 个工具:\n` +
        newTools.map((t) => `  - ${t.name}: ${t.description.slice(0, 80)}`).join('\n')
      );
    },
  },

  // ---------- 通用模型辅助 — AI 干不动时可让其他 model 帮忙 ----------
  {
    rawName: 'delegate_to_model',
    description:
      '当你认为自己处理某项任务能力不足(代码极复杂 / 需要更强推理 / 上下文超出 / 你不擅长的领域 等)时,' +
      '把任务委托给另一个 model 处理。用户会看到一个确认弹窗(显示要找谁、为什么),允许后系统会用目标 model 跑一次,' +
      '把结果作为 tool 结果返回给你,你再综合自己的人设和工具结果给用户答复。' +
      '⚠ 不要轻易调用 — 你能直接答的就直接答。仅在你真的卡住、能力明显不足时才调。' +
      '⚠ 调用时优先用「默认辅助」(profile_id 和 model 留空即可,系统会用用户在设置里配的默认辅助)。' +
      '只有当默认辅助也不合适(比如默认是个文本模型但任务需要数学推理)时,才显式指定 profile_id + model 从可用清单里挑别的。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '完整的任务描述,会作为 user message 直接发给目标 model。要自包含 — 目标 model 看不到你的上下文。',
        },
        reason: {
          type: 'string',
          description: '一句话解释为什么需要换 model 帮忙。会显示给用户看,让他判断是否同意。',
        },
        profile_id: {
          type: 'string',
          description: '可选。目标 model 所在的 provider profile id;留空 = 用默认辅助。',
        },
        model: {
          type: 'string',
          description: '可选。目标 model 名,必须存在于该 profile 的 modelPresets 里;留空 = 用默认辅助。',
        },
      },
      required: ['prompt'],
    },
    mutating: true, // 走 confirm 弹窗 — 让用户看到 AI 想找谁帮忙
    handler: async (args) => {
      const cfg = loadConfig();
      const ga = cfg.generalAssist;
      if (!ga?.enabled) {
        throw new Error('通用模型辅助未启用,无法委托。请先在 设置 里打开「启用模型辅助」。');
      }
      const profiles = cfg.providerProfiles ?? [];
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) throw new Error('prompt 不能为空');
      const reqProfileId = String(args.profile_id ?? '').trim();
      const reqModel = String(args.model ?? '').trim();

      // 解析最终用哪个 profile + model
      let profileId = reqProfileId || ga.assistantProfileId || '';
      let model = reqModel || ga.assistantModel || '';

      // 都没有 → 兜底从所有 profile 里挑第一个有 model 的
      if ((!profileId || !model) && ga.fallbackAcrossAll) {
        for (const p of profiles) {
          if (!p.baseURL || !p.apiKey) continue;
          const m = p.modelPresets?.[0] || p.model;
          if (m) {
            profileId = p.id;
            model = m;
            break;
          }
        }
      }
      if (!profileId || !model) {
        throw new Error('未指定目标 model 也没默认辅助。请在 设置 → AI 设置 → 模型辅助 里配一个默认辅助 model。');
      }
      const p = profiles.find((x) => x.id === profileId);
      if (!p) throw new Error(`找不到 profile_id="${profileId}"`);
      if (!p.baseURL || !p.apiKey) throw new Error(`profile "${p.name}" 没填 baseURL 或 apiKey`);

      const text = await oneShotChat(p.baseURL, p.apiKey, model, [
        { role: 'user', content: prompt },
      ]);
      if (!text) throw new Error(`目标 model "${model}" 调用失败或返回空`);
      return `[由 ${p.name}/${model} 给出的辅助答复]\n${text}`;
    },
  },

  // ---------- 系统信息(只读, 给 AI 自我感知) ----------
  {
    rawName: 'get_system_info',
    description: '返回当前主机的简要信息(平台/用户名/家目录/桌面路径等),只读。',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: () => {
      return JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          userInfo: { username: os.userInfo().username, homedir: os.homedir() },
          desktop: app.getPath('desktop'),
          documents: app.getPath('documents'),
          downloads: app.getPath('downloads'),
          temp: os.tmpdir(),
          cwd: process.cwd(),
        },
        null,
        2,
      );
    },
  },
];

/** 简易 OpenAI 兼容 /chat/completions 请求 — 非流式,返回 assistant content。
 *  失败返回 null(由调用方决定怎么报错给 AI / 用户)。
 *  这里独立实现而不复用 ai-client.ts,避免循环依赖(builtin-tools 本身被 mcp-client / ai-client 链入)。 */
async function oneShotChat(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<string | null> {
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({ model, stream: false, messages });
  return new Promise((resolve) => {
    const request = net.request({ method: 'POST', url });
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Authorization', `Bearer ${apiKey}`);
    let buf = '';
    let status = 0;
    request.on('response', (resp) => {
      status = resp.statusCode;
      resp.on('data', (b: Buffer) => {
        buf += b.toString('utf-8');
      });
      resp.on('end', () => {
        if (status >= 400) {
          console.warn('[delegate] HTTP', status, buf.slice(0, 200));
          resolve(null);
          return;
        }
        try {
          const j = JSON.parse(buf);
          const text = j?.choices?.[0]?.message?.content;
          resolve(typeof text === 'string' && text.trim() ? text.trim() : null);
        } catch (e) {
          console.warn('[delegate] parse failed:', (e as Error).message);
          resolve(null);
        }
      });
      resp.on('error', () => resolve(null));
    });
    request.on('error', (err) => {
      console.warn('[delegate] request error:', err.message);
      resolve(null);
    });
    request.write(body);
    request.end();
  });
}

// ---- 列已安装应用(开始菜单 .lnk / Applications .app)----
interface AppEntry {
  name: string;
  path: string;
}
let appsCache: AppEntry[] | null = null;
let appsCacheAt = 0;
function listInstalledApps(): AppEntry[] {
  // 缓存 30 秒,反复 list 不重扫
  if (appsCache && Date.now() - appsCacheAt < 30_000) return appsCache;
  const out: AppEntry[] = [];
  if (process.platform === 'win32') {
    const roots = [
      path.join(process.env.ProgramData ?? 'C:/ProgramData', 'Microsoft/Windows/Start Menu/Programs'),
      path.join(
        process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'),
        'Microsoft/Windows/Start Menu/Programs',
      ),
    ];
    for (const root of roots) walkLnk(root, out);
  } else if (process.platform === 'darwin') {
    walkApp('/Applications', out);
    walkApp(path.join(os.homedir(), 'Applications'), out);
  } else {
    // Linux:扫 /usr/share/applications/*.desktop
    walkDesktop('/usr/share/applications', out);
    walkDesktop(path.join(os.homedir(), '.local/share/applications'), out);
  }
  // 去重(同名取一)
  const seen = new Set<string>();
  const dedup = out.filter((x) => {
    const k = x.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  dedup.sort((a, b) => a.name.localeCompare(b.name));
  appsCache = dedup;
  appsCacheAt = Date.now();
  return dedup;
}
function walkLnk(dir: string, out: AppEntry[]): void {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkLnk(full, out);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
        out.push({ name: path.basename(entry.name, path.extname(entry.name)), path: full });
      }
    }
  } catch {
    // ignore EPERM 等
  }
}
function walkApp(dir: string, out: AppEntry[]): void {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.endsWith('.app')) {
        out.push({ name: path.basename(entry.name, '.app'), path: path.join(dir, entry.name) });
      } else if (entry.isDirectory()) {
        walkApp(path.join(dir, entry.name), out);
      }
    }
  } catch {
    // ignore
  }
}
function walkDesktop(dir: string, out: AppEntry[]): void {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.desktop')) continue;
      const full = path.join(dir, entry);
      try {
        const txt = fs.readFileSync(full, 'utf-8');
        const nameM = txt.match(/^Name=(.+)$/m);
        out.push({ name: nameM ? nameM[1].trim() : path.basename(entry, '.desktop'), path: full });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// ---- HTTP / 搜索 helpers ----

/** 按 Content-Encoding 解压响应。支持 gzip / deflate / br;空 / identity / 未知值原样返回。
 *  没装第三方依赖,Node 内置 zlib 完全够用。 */
function decodeBody(raw: Buffer, ce: string): Buffer {
  if (!ce || ce === 'identity') return raw;
  // 有些服务器用逗号分隔多种 — 取第一段(最外层)
  const primary = ce.split(',')[0].trim();
  if (primary === 'gzip' || primary === 'x-gzip') return zlib.gunzipSync(raw);
  if (primary === 'deflate') {
    // 兼容裸 deflate(无 zlib header)和带 header 的 — 失败再 inflateRawSync
    try {
      return zlib.inflateSync(raw);
    } catch {
      return zlib.inflateRawSync(raw);
    }
  }
  if (primary === 'br') return zlib.brotliDecompressSync(raw);
  // zstd 等暂不支持 → 原样,文本不一定能读但不抛
  return raw;
}

/** 简单 HTTP GET,跟 5 次重定向,12 秒超时;支持 gzip/deflate/br 自动解压。 */
function httpGet(
  url: string,
  hops = 0,
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    if (hops > 5) {
      reject(new Error('too many redirects'));
      return;
    }
    const req = net.request({
      method: 'GET',
      url,
      redirect: 'manual', // 自己处理重定向(net 默认 follow,但偶尔不全)
    });
    req.setHeader(
      'User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 DesktopPet/1.0',
    );
    req.setHeader('Accept', 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8');
    req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    // 主动声明能处理这三种压缩 — Content-Encoding 命中时下面用 zlib 解
    req.setHeader('Accept-Encoding', 'gzip, deflate, br');
    const timer = setTimeout(() => {
      try {
        req.abort();
      } catch {
        // ignore
      }
      reject(new Error('http timeout (12s)'));
    }, 12_000);
    req.on('response', (resp) => {
      // 3xx 重定向手动跟
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        clearTimeout(timer);
        const loc = Array.isArray(resp.headers.location)
          ? resp.headers.location[0]
          : (resp.headers.location as string);
        const next = new URL(loc, url).toString();
        httpGet(next, hops + 1).then(resolve, reject);
        return;
      }
      const ctRaw = resp.headers['content-type'];
      const ct = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw ?? 'application/octet-stream') as string;
      const ceRaw = resp.headers['content-encoding'];
      const ce = ((Array.isArray(ceRaw) ? ceRaw[0] : ceRaw ?? '') as string)
        .toLowerCase()
        .trim();
      const chunks: Buffer[] = [];
      let total = 0;
      // 压缩响应允许更大原始字节(解压后实际文本量已被上层 60KB 截断)
      const limit = ce ? 4 * 1024 * 1024 : 1024 * 1024;
      resp.on('data', (chunk: Buffer) => {
        if (total >= limit) return;
        chunks.push(chunk);
        total += chunk.length;
      });
      resp.on('end', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).slice(0, limit);
        let bodyStr: string;
        try {
          const decoded = decodeBody(raw, ce);
          bodyStr = decoded.toString('utf-8');
        } catch (e) {
          // 解压失败 → 兜底当原文(很多服务器虽然标 gzip 实际不是)
          bodyStr = raw.toString('utf-8');
          console.warn('[http_fetch] decode failed, fallback raw:', (e as Error).message);
        }
        resolve({ status: resp.statusCode, contentType: ct, body: bodyStr });
      });
      resp.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

/** 把 HTML 剥成纯文本:去 script/style/noscript,去标签,合并空白。 */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

/** 统一搜索结果类型 */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 多引擎派发 — 失败抛错(让上层 fallback) */
async function searchEngine(
  engine: 'bing' | 'duckduckgo' | 'sogou',
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  if (engine === 'duckduckgo') return duckDuckGoSearch(query, limit);
  if (engine === 'bing') return bingSearch(query, limit);
  if (engine === 'sogou') return sogouSearch(query, limit);
  throw new Error('unknown engine: ' + engine);
}

/** Bing HTML 搜索 — 国内 cn.bing.com 可达,字段稳定。
 *  结果块: <li class="b_algo"> <h2><a href="..."> 标题 </a></h2> ... <p>摘要</p> </li> */
async function bingSearch(query: string, limit: number): Promise<SearchResult[]> {
  const enc = encodeURIComponent(query);
  const r = await httpGet(`https://cn.bing.com/search?q=${enc}&form=QBLH`);
  const html = r.body;
  const results: SearchResult[] = [];
  const re =
    /<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    const url = m[1];
    const title = stripHtml(m[2]).trim();
    // snippet 在 <p> 或 <div class="b_caption"> 里
    const tail = m[3];
    const pm =
      tail.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ||
      tail.match(/<div[^>]+class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = pm ? stripHtml(pm[1]).trim() : '';
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

/** Sogou HTML 搜索 — 国内备选。
 *  结果块: <h3 class="vr-title"><a href="..."> 标题 </a></h3> 然后 .text-layout 里的摘要 */
async function sogouSearch(query: string, limit: number): Promise<SearchResult[]> {
  const enc = encodeURIComponent(query);
  const r = await httpGet(`https://www.sogou.com/web?query=${enc}`);
  const html = r.body;
  const results: SearchResult[] = [];
  const re =
    /<h3[^>]+class="[^"]*vr-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>([\s\S]*?)(?=<h3[^>]+class="[^"]*vr-title|<\/div>\s*<div[^>]+id="ws_recommend|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    let url = m[1];
    // sogou 的 link 可能是 /link?url=encoded 或者完整 url。如果是相对路径,补上前缀
    if (url.startsWith('/')) url = 'https://www.sogou.com' + url;
    const title = stripHtml(m[2]).trim();
    const snippet = stripHtml(m[3]).trim().slice(0, 240);
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

/** DuckDuckGo HTML 端点搜索,正则提取结果(标题 / URL / 摘要)。
 *  这个端点是给浏览器降级渲染的纯 HTML 页,字段稳定,无需 API key。 */
async function duckDuckGoSearch(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const enc = encodeURIComponent(query);
  const r = await httpGet(`https://html.duckduckgo.com/html/?q=${enc}`);
  const html = r.body;
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // 每条结果是 <a class="result__a" href="...">标题</a> ... <a class="result__snippet">摘要</a>
  const re =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    let url = m[1];
    // DDG 把真实 URL 包成 /l/?uddg=<encoded>
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        // ignore
      }
    }
    const title = stripHtml(m[2]).trim();
    const snippet = stripHtml(m[3]).trim();
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

// ---- 对外 API ----

export interface BuiltinToolDesc {
  name: string; // 'app__open_url'
  rawName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listBuiltinTools(): BuiltinToolDesc[] {
  return TOOLS.map((t) => ({
    name: `${APP_PREFIX}__${t.rawName}`,
    rawName: t.rawName,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function isBuiltinTool(prefixedName: string): boolean {
  return prefixedName.startsWith(`${APP_PREFIX}__`);
}

export function isBuiltinMutating(prefixedName: string): boolean {
  if (!isBuiltinTool(prefixedName)) return false;
  const raw = prefixedName.slice(APP_PREFIX.length + 2);
  const t = TOOLS.find((x) => x.rawName === raw);
  return !!t?.mutating;
}

export async function callBuiltinTool(
  prefixedName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!isBuiltinTool(prefixedName)) throw new Error('not a builtin tool: ' + prefixedName);
  const raw = prefixedName.slice(APP_PREFIX.length + 2);
  const t = TOOLS.find((x) => x.rawName === raw);
  if (!t) throw new Error('unknown builtin tool: ' + raw);
  const result = await t.handler(args);
  return typeof result === 'string' ? result : JSON.stringify(result);
}
