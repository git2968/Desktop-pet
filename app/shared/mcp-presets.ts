/**
 * MCP server 预置模板 — 前端(设置面板下拉选项)和后端(让 AI 自己装)共享。
 *
 * 注意:外部 preset(npx / uvx)需要用户机器装有 Node + npm 或 Python + uv。
 * 第一次启动时 npx/uvx 会自动下载包到缓存,这就是"下载到本地"的实现 — 我们不主动 npm install,
 * 而是 spawn 时由 npx/uvx 按需拉取。
 */

import type { McpServerSpec } from '../electron/preload';

export interface McpPreset {
  /** 唯一 id,会作为新 server 的默认 id 前缀 */
  id: string;
  /** UI 下拉显示的 label */
  label: string;
  /** 一句话给 AI 看的能力描述 — install 工具会把它告诉 AI */
  description: string;
  /** 默认生成的 spec(args/env 通常需用户改) */
  template: Omit<McpServerSpec, 'id' | 'enabled'>;
  /** 用户提示 — 这个 server 需要装什么、配什么 */
  hint?: string;
  /** 必填的 env key 列表(install 时若用户没传,需要让用户去 UI 填) */
  requiredEnv?: string[];
  /** 必填的 args 占位符 — 用户必须替换才能跑(如 <repo-path>) */
  argsPlaceholders?: string[];
  /** 一键安装配置(可选)。提供后 UI 会显示「一键安装」按钮:
   *  - kind 'npm-global':先跑 `npm install -g <package>`,再用 `npm root -g` 探测根,
   *    把 args 第一个占位符替换为 `<root>/<package>/<stdioRelPath>`。
   *  - kind 'npx':无需全局装,template.args 已是 npx 命令。本工具会:
   *    ① 验证 npx 可用(spawn `npx --version`)② 直接添加 spec ③ applyConfig 启动 server
   *    ④ 弹 postSetupHint 引导用户做手动步骤(如装扩展、Connect)。
   *  - postSetupUrl:装完弹窗指引用户访问该链接(装扩展、申请 key 等手动步骤)。 */
  oneClickInstall?:
    | {
        kind: 'npm-global';
        package: string;
        stdioRelPath: string;
        postSetupUrl?: string;
        postSetupHint?: string;
      }
    | {
        kind: 'npx';
        postSetupUrl?: string;
        postSetupHint?: string;
      };
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'fs',
    label: 'Filesystem — 读写本地文件(已内置,免装)',
    description:
      '读写本地文件 / 目录。提供 read_file / read_text_file / write_file / edit_file / list_directory / directory_tree / search_files / move_file / create_directory 等工具。需要在 args 里指定允许访问的目录白名单。',
    template: {
      name: 'Filesystem',
      command: 'bundled-fs',
      args: [],
    },
    hint: '在 args 里填允许访问的目录(每行一个绝对路径)',
  },
  {
    id: 'memory',
    label: 'Memory — 跨会话长期记忆 KV(npx)',
    description:
      '基于知识图谱的长期记忆 KV。提供 create_entities / create_relations / add_observations / search_nodes / read_graph / delete_entities 等工具。可让 AI 跨会话记住用户偏好、上下文。',
    template: {
      name: 'Memory',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    hint: '需要本机已装 Node + npx',
  },
  {
    id: 'sequential_thinking',
    label: 'Sequential Thinking — 引导 AI 分步推理(npx)',
    description:
      '引导式分步推理工具,提供 sequentialthinking 工具,适合复杂问题分解和逐步求解。',
    template: {
      name: 'Sequential Thinking',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    hint: '需要本机已装 Node + npx',
  },
  {
    id: 'github',
    label: 'GitHub — 仓库 / Issue / PR 操作(npx)',
    description:
      'GitHub API 工具,提供 create_repository / search_repositories / create_issue / create_pull_request / fork_repository 等。需要 Personal Access Token。',
    template: {
      name: 'GitHub',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    },
    hint: '需要 Node + 在 env 里填 GITHUB_PERSONAL_ACCESS_TOKEN',
    requiredEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'brave',
    label: 'Brave Search — 网页搜索 API(npx)',
    description:
      'Brave Search API,真正能把网页搜索结果返回给 AI(不像内置 web_search 只是开浏览器)。需要 BRAVE_API_KEY(免费额度)。',
    template: {
      name: 'Brave Search',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: '' },
    },
    hint: '需要 Node + 在 env 里填 BRAVE_API_KEY(brave.com 申请)',
    requiredEnv: ['BRAVE_API_KEY'],
  },
  {
    id: 'fetch',
    label: 'Fetch — HTTP 抓取(uvx,Python)',
    description:
      'HTTP 抓取工具,fetch URL 把网页内容(HTML/JSON)返回给 AI 看。',
    template: {
      name: 'Fetch',
      command: 'uvx',
      args: ['mcp-server-fetch'],
    },
    hint: '需要 Python + uv(astral-sh)',
  },
  {
    id: 'git',
    label: 'Git — 仓库操作(uvx,Python)',
    description:
      'Git 仓库工具:status / diff / log / show / commit / branch / checkout 等。需要在 args 里指定仓库路径。',
    template: {
      name: 'Git',
      command: 'uvx',
      args: ['mcp-server-git', '--repository', '<改成仓库路径>'],
    },
    hint: '需要 Python + uv;在 args 里把 <改成仓库路径> 替换成绝对路径',
    argsPlaceholders: ['<改成仓库路径>'],
  },
  {
    id: 'time',
    label: 'Time — 时区 / 当前时间(uvx,Python)',
    description: '时区转换 / 当前时间工具。注:内置已有 app__get_current_time,通常不必装。',
    template: {
      name: 'Time',
      command: 'uvx',
      args: ['mcp-server-time'],
    },
    hint: '需要 Python + uv',
  },
  {
    id: 'sqlite',
    label: 'SQLite — 数据库查询(uvx,Python)',
    description:
      'SQLite 查询工具:read_query / write_query / list_tables / describe_table。需要在 args 里指定 .db 文件路径。',
    template: {
      name: 'SQLite',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', '<改成 .db 文件路径>'],
    },
    hint: '需要 Python + uv;在 args 里替换 <改成 .db 文件路径>',
    argsPlaceholders: ['<改成 .db 文件路径>'],
  },
  {
    id: 'postgres',
    label: 'Postgres — 数据库查询(npx)',
    description:
      'Postgres 只读查询工具:query / schema。需要在 args 里填连接 URL。',
    template: {
      name: 'Postgres',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', '<改成连接 URL>'],
    },
    hint: '需要 Node;在 args 里替换 <改成连接 URL>,如 postgresql://user:pwd@host/db',
    argsPlaceholders: ['<改成连接 URL>'],
  },
  {
    id: 'puppeteer',
    label: 'Puppeteer — 浏览器自动化(npx,会下载 Chromium)',
    description:
      '浏览器自动化:navigate / screenshot / click / fill / evaluate JavaScript。⚠ 这是独立 Chromium 实例,不共享你当前浏览器的登录态/标签页。想读"你当前正在用的浏览器"页面请用 BrowserMCP 或 chrome-devtools-mcp。',
    template: {
      name: 'Puppeteer',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    },
    hint: '首次启动会下载 Chromium,体积大;独立浏览器实例,读不到你已登录的页面',
  },
  {
    id: 'browsermcp',
    label: 'BrowserMCP — 读你当前浏览器(需装扩展)',
    description:
      '通过浏览器扩展 attach 到你当前 active 标签页,读 DOM / 截图 / 点击 / 填表 / 拿 console。能拿到你已登录站点(如 DeepSeek 网页对话)的真实内容,与 Puppeteer 完全不同 — Puppeteer 启的是空白独立浏览器,BrowserMCP 用你正在用的那个。',
    template: {
      name: 'BrowserMCP',
      command: 'npx',
      args: ['-y', '@browsermcp/mcp@latest'],
    },
    hint:
      '推荐点上面「一键安装」让桌宠直接添加并启动这个 server。' +
      '装完会弹窗引导你装浏览器扩展,然后在扩展里点"Connect"绑定到当前标签页。' +
      '⚠ 注意:扩展必须用 docs.browsermcp.io 那一套,与 Chrome MCP 的扩展不兼容。',
    oneClickInstall: {
      kind: 'npx',
      postSetupUrl: 'https://docs.browsermcp.io/setup-extension',
      postSetupHint:
        'BrowserMCP server 已启动!现在装浏览器扩展:\n' +
        '1) 打开 docs.browsermcp.io/setup-extension,跟着指引装 Chrome/Edge 扩展。\n' +
        '2) 装好后点扩展图标 → 切到你想让 AI 看的标签页 → 点 "Connect"。\n' +
        '3) 回到桌宠,问 AI "看下我现在浏览器在看什么",它就能直接读到那个标签页内容。\n' +
        '⚠ 如果之前装过 Chrome MCP 的 hangwin 扩展,要先把它禁用 — 两套扩展协议不兼容。',
    },
  },
  {
    id: 'mcp_chrome',
    label: 'Chrome MCP — 你当前 Chrome 全功能(扩展 + 语义搜索)',
    description:
      'hangwin/mcp-chrome:通过 Chrome 扩展暴露当前浏览器能力,功能比 BrowserMCP 更全 — 含跨标签操作、内容语义搜索、历史/书签/网络请求/截图/脚本注入等 20+ 工具。需要全局安装 mcp-chrome-bridge。',
    template: {
      name: 'Chrome MCP',
      command: 'node',
      args: ['<改成 mcp-server-stdio.js 绝对路径>'],
    },
    hint:
      '推荐点上面「一键安装」让桌宠自动跑 `npm install -g mcp-chrome-bridge` 并探测路径。' +
      '装完会弹窗引导你下载并加载 Chrome 扩展,再点扩展图标 → Connect 即可。',
    argsPlaceholders: ['<改成 mcp-server-stdio.js 绝对路径>'],
    oneClickInstall: {
      kind: 'npm-global',
      package: 'mcp-chrome-bridge',
      stdioRelPath: 'dist/mcp/mcp-server-stdio.js',
      postSetupUrl: 'https://github.com/hangwin/mcp-chrome/releases',
      postSetupHint:
        '安装完成!最后两步要手动:\n' +
        '1) 从打开的 Release 页下载 Chrome 扩展 zip,解压。\n' +
        '2) Chrome/Edge 打开 chrome://extensions/,开启开发者模式,点"加载已解压的扩展"选解压后的文件夹。\n' +
        '3) 点扩展图标 → Connect,然后回到桌宠开始使用。',
    },
  },
  {
    id: 'chrome_devtools',
    label: 'Chrome DevTools — attach 到已开调试端口的 Chrome/Edge',
    description:
      'Google 官方 chrome-devtools-mcp,通过 CDP(Chrome DevTools Protocol)attach 到一个已经启动 --remote-debugging-port 的 Chrome/Edge 实例,读取页面 DOM / 截图 / 控制台 / 网络请求。',
    template: {
      name: 'Chrome DevTools',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', 'http://localhost:9222'],
    },
    hint:
      '使用前需用 `--remote-debugging-port=9222` 参数启动 Chrome/Edge,' +
      '例如 `msedge.exe --remote-debugging-port=9222`。' +
      '⚠ 注意调试端口会暴露浏览器内所有页面/cookie,只在本机使用。',
  },
  {
    id: 'custom',
    label: '自定义 server — 任意 command/args/env',
    description: '完全自定义的 stdio MCP server。command/args/env 全靠用户手填。',
    template: {
      name: 'Custom',
      command: '',
      args: [],
    },
    hint: '完全手填:command、args(回车分隔)、env(KEY=VAL 回车分隔)',
  },
];
