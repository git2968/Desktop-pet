import { net, BrowserWindow, ipcMain } from 'electron';
import { loadConfig, getActiveSystemPrompt, getProactiveConfig, type AppConfig } from './config-store.js';
import { mcpManager } from './mcp-client.js';
import { formatMemoriesForPrompt } from './memory-store.js';
import { listSkills } from './skill-registry.js';

/** OpenAI 多模态 content 单元(user 消息可以混合文本和图片)。 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** assistant 触发工具调用时,消息里带的 tool_calls 字段(OpenAI 格式) */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** string 是普通文本;ChatContentPart[] 用于多模态(图片+文本)。
   *  tool_calls 时 content 可以为空字符串(assistant);
   *  role='tool' 时 content 是 stringified tool result,tool_call_id 指回 call。 */
  content: string | ChatContentPart[] | null;
  /** assistant 触发工具调用(一轮可能多个) */
  tool_calls?: ChatToolCall[];
  /** DeepSeek thinking-mode:assistant 消息回传时必须带上原始的 reasoning_content,否则 API 会 400 */
  reasoning_content?: string;
  /** role='tool' 时必填,对应的 assistant call id */
  tool_call_id?: string;
  /** role='tool' 时可选,工具名(便于 debug;OpenAI 不强制) */
  name?: string;
}

/** 单轮流式解析产物 */
interface TurnChunk {
  kind: 'answer' | 'thinking';
  text: string;
}

/** 流式累积的 tool_call 增量(按 index 聚合) */
interface ToolCallAccum {
  id: string;
  name: string;
  argsBuffer: string;
}

// ---------------- 写操作确认 ----------------
/** pending 确认请求:id → resolver。主进程往渲染端发 'mcp:confirm-request',
 *  渲染端点击后调 'mcp:respond-confirm' IPC,这里 resolve 对应 promise。 */
const pendingConfirms = new Map<string, (approve: boolean) => void>();
/** 本次进程生命周期内"总是允许"的工具名集合 — 用户在确认弹窗里勾选后命中。
 *  不持久化:重启 electron 即清空,避免误授权一直留着。 */
const alwaysAllowTools = new Set<string>();

ipcMain.handle(
  'mcp:respond-confirm',
  (_e, id: string, approve: boolean, alwaysAllow?: boolean, toolName?: string) => {
    if (approve && alwaysAllow && toolName) {
      alwaysAllowTools.add(toolName);
    }
    const resolver = pendingConfirms.get(id);
    if (resolver) {
      pendingConfirms.delete(id);
      resolver(!!approve);
    }
  },
);

function askUserConfirm(
  win: BrowserWindow,
  toolName: string,
  args: unknown,
): Promise<boolean> {
  // 本次进程内已被"总是允许" → 直接通过
  if (alwaysAllowTools.has(toolName)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const id = 'cfm' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    pendingConfirms.set(id, resolve);
    win.webContents.send('mcp:confirm-request', { id, toolName, args });
    // 超时保护:60s 没回就自动拒绝
    setTimeout(() => {
      if (pendingConfirms.has(id)) {
        pendingConfirms.delete(id);
        resolve(false);
      }
    }, 60_000);
  });
}

// ---------------- SSE 解析 ----------------

/**
 * SSE 解析。支持字段:
 *   - delta.content           普通回答
 *   - delta.reasoning_content 推理模型思考过程
 *   - delta.tool_calls[]      工具调用增量(按 index 聚合到 outer accum)
 *   - choices[0].finish_reason 可能是 'stop' / 'tool_calls' / 'length' 等
 */
function parseSseChunk(
  text: string,
  toolAccums: Map<number, ToolCallAccum>,
): {
  chunks: TurnChunk[];
  done: boolean;
  finishReason: string | null;
  rest: string;
} {
  const chunks: TurnChunk[] = [];
  let done = false;
  let finishReason: string | null = null;
  const lines = text.split(/\r?\n/);
  const completeLines = lines.slice(0, -1);
  const rest = lines[lines.length - 1] ?? '';
  for (const line of completeLines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const obj = JSON.parse(payload);
      const choice = obj?.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          chunks.push({ kind: 'answer', text: delta.content });
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          chunks.push({ kind: 'thinking', text: delta.reasoning_content });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (Array.isArray(delta.tool_calls)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const tc of delta.tool_calls as any[]) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let cur = toolAccums.get(idx);
            if (!cur) {
              cur = { id: '', name: '', argsBuffer: '' };
              toolAccums.set(idx, cur);
            }
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') {
              cur.argsBuffer += tc.function.arguments;
            }
          }
        }
      }
    } catch {
      // ignore malformed
    }
  }
  return { chunks, done, finishReason, rest };
}

// ---------------- 单轮请求 ----------------

interface TurnResult {
  assistantText: string;
  /** 推理模型(DeepSeek-Reasoner 等)的 reasoning_content 累积。
   *  thinking 模式下,要把它原样作为 assistant message 的字段回传给 API,否则下一轮会被拒。 */
  reasoningContent: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
}

/**
 * 发一轮 /chat/completions,流式解析。把 answer/thinking chunk 实时推给渲染端;
 * tool_calls 累积后返回给 streamChat 外层处理。
 * 注意:轮内不发 ai:done,只有最终轮结束才发。
 */
function streamOneTurn(
  win: BrowserWindow,
  reqId: string,
  baseURL: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[] | null,
  onChunk: (c: TurnChunk) => void,
): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
    const bodyObj: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) {
      bodyObj.tools = tools;
      bodyObj.tool_choice = 'auto';
    }
    const body = JSON.stringify(bodyObj);

    const request = net.request({ method: 'POST', url });
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Authorization', `Bearer ${apiKey}`);
    request.setHeader('Accept', 'text/event-stream');

    let buffer = '';
    let statusCode = 0;
    let gotAssistantText = '';
    let gotReasoning = '';
    const toolAccums = new Map<number, ToolCallAccum>();
    let finishReason: string | null = null;

    request.on('response', (resp) => {
      statusCode = resp.statusCode;
      if (statusCode >= 400) {
        let errBody = '';
        resp.on('data', (chunk) => {
          errBody += chunk.toString('utf-8');
        });
        resp.on('end', () => {
          const detail = extractErrorDetail(errBody);
          const hint = buildErrorHint(statusCode, detail);
          const msg = `HTTP ${statusCode}: ${detail}${hint}`;
          reject(new Error(msg));
        });
        return;
      }
      resp.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const parsed = parseSseChunk(buffer, toolAccums);
        buffer = parsed.rest;
        if (parsed.finishReason) finishReason = parsed.finishReason;
        for (const c of parsed.chunks) {
          if (c.kind === 'answer') gotAssistantText += c.text;
          else if (c.kind === 'thinking') gotReasoning += c.text;
          onChunk(c);
          win.webContents.send('ai:chunk', { reqId, delta: c.text, kind: c.kind });
        }
      });
      resp.on('end', () => {
        const toolCalls: ChatToolCall[] = [];
        const sorted = Array.from(toolAccums.entries()).sort((a, b) => a[0] - b[0]);
        for (const [, acc] of sorted) {
          if (!acc.id || !acc.name) continue;
          toolCalls.push({
            id: acc.id,
            type: 'function',
            function: { name: acc.name, arguments: acc.argsBuffer || '{}' },
          });
        }
        resolve({
          assistantText: gotAssistantText,
          reasoningContent: gotReasoning,
          toolCalls,
          finishReason,
        });
      });
      resp.on('error', (err: Error) => reject(err));
    });

    request.on('error', (err) => reject(err));
    request.write(body);
    request.end();
  });
}

function extractErrorDetail(errBody: string): string {
  const trimmed = errBody.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      return j?.error?.message || j?.message || trimmed.slice(0, 200);
    } catch {
      return trimmed.slice(0, 200);
    }
  }
  if (trimmed.startsWith('<')) {
    const m = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1] : '服务端返回了 HTML 错误页(可能是 WAF/Cloudflare 拦截)';
  }
  return trimmed.slice(0, 200);
}

function buildErrorHint(statusCode: number, detail: string): string {
  let hint = '';
  if (statusCode === 401 || statusCode === 403) {
    hint = '\n· API key 无效或权限不足';
  } else if (statusCode === 404) {
    hint = '\n· baseURL 不正确,请确认例如 https://api.deepseek.com 或末尾 /v1';
  } else if (statusCode === 429) {
    hint = '\n· 速率/配额超限,或被 WAF 拦截';
  } else if (statusCode >= 500) {
    hint = '\n· 服务端错误,请稍后重试';
  }
  if (/tool_choice|tools|function_call/i.test(detail)) {
    hint +=
      '\n· 当前模型可能不支持 function/tools。请在 设置 里关闭"AI 工具(MCP)"总开关,' +
      '\n  或换一个支持 tool calling 的模型(gpt-4o / claude-3-5 / deepseek-chat / qwen-max / glm-4 等)';
  }
  if (/image_url|unknown\s+variant|expected\s+'?text|multimodal|vision|不支持.*图片/i.test(detail)) {
    hint =
      '\n· 当前模型不支持图片输入。请在 设置 → AI → Model 换成支持 vision 的模型';
  }
  return hint;
}

// ---------------- 外层 tool calling 循环 ----------------

/** 把当前 skill-registry 里的 skill 列表拼成一段引导,给 AI 看到"自己装备了什么"。
 *  返回空字符串表示"用户禁用了 agentSkills,不要在 prompt 里提"。 */
function buildSkillGuide(agentSkillsEnabled: boolean): string {
  if (!agentSkillsEnabled) return '';
  const skills = listSkills();
  const head =
    '  - 用户需求可能命中已装备的 SKILL.md(编程、写作、角色 persona、方法论等)→ ' +
    '**优先**调 app__list_skills 看有没有相关 skill,有就 app__query_skill(skill_id="<source>:<name>") ' +
    '拿对应 markdown 作为参考再回答。';
  if (skills.length === 0) {
    return (
      head +
      ' 注意:目前 skill 列表为空(可能首次启动同步未完成或网络访问 GitHub 失败),试着调 list_skills 一次,几秒后通常就同步好了;实在没列表就用你自己的知识。'
    );
  }
  // 直接给 AI 看到所有 skill id,省得它先调 list_skills 浪费 round
  // 按 source 分组展示更清晰
  const bySource = new Map<string, string[]>();
  for (const s of skills) {
    const arr = bySource.get(s.sourceId) ?? [];
    arr.push(s.rawId);
    bySource.set(s.sourceId, arr);
  }
  const groupLines: string[] = [];
  for (const [src, ids] of bySource) {
    groupLines.push(`      · ${src}:  ${ids.join(', ')}`);
  }
  return (
    head +
    `\n      已装备 ${skills.length} 个 skill(分布在 ${bySource.size} 个源):\n` +
    groupLines.join('\n') +
    `\n      调用时用全限定 id,如 app__query_skill(skill_id="${skills[0].id}")。看到用户问题关键词跟某个 skill 沾边就直接 query_skill 拿内容,不必先 list。`
  );
}

/** 给 AI 一段简短的工具使用引导,让它主动调而不是只会聊天回复
 *  "我没办法帮你打开浏览器"。tools 已经传给模型,这里只是再用自然语言点一下。 */
function buildToolGuide(tools: unknown[], agentSkillsEnabled: boolean): string {
  const names = tools
    .map((t) => {
      const fn = (t as { function?: { name?: string } }).function;
      return fn?.name ?? '';
    })
    .filter(Boolean);
  // 列出主要分组,prompt 不能太长
  const list = names.slice(0, 40).join(', ');
  // 自检:有没有 filesystem 类工具(fs__read_file 等),给一段更精细的引导
  const hasFs = names.some((n) => /^fs__|filesystem__/.test(n));
  return [
    '【工具能力】你已注册以下工具,可以直接通过 tool_calls 调用,而不是说"我做不到":',
    list,
    '使用建议:',
    '  - 用户让你做事时(打开 / 启动 / 写入 / 搜索 / 改 / 列出 / 通知…),直接调相应工具,不要只说步骤。',
    '  - 「读 / 看 / 查看 / 分析 / 总结 / 解释」一个文件或目录的内容 →',
    hasFs
      ? '      优先用 fs__ 系列工具(fs__read_file / fs__read_text_file / fs__list_directory / fs__directory_tree)— 它们没有用户确认。也可用 app__read_text_file / app__list_directory(每次会弹确认)。**绝对不要用 app__open_path**,那只是启动外部程序窗口,不会把内容给你。'
      : '      用内置 app__read_text_file(读单个文件)或 app__list_directory(列目录)— 用户会看到一次"AI 想读 X"的确认弹窗,允许后内容直接返回给你。需要批量 / 递归读时再 app__install_mcp_server 装 fs server。**不要用 app__open_path 充当读取**,那只是启动外部程序窗口。',
    '  - 「打开 / 启动 / 在资源管理器里看 / 跑」一个文件或文件夹 → 用 app__open_path 或 app__open_app。',
    '  - 「帮我看看 / 搜一下 / 最近的 X 新闻 / Y 是什么」→ 先调 app__http_search(后台搜,不打扰用户),拿到 5~8 条结果后挑 1~3 条最相关的用 app__http_fetch 抓正文(自动剥 HTML),综合后回答。**绝对不要默认调 app__web_search**(那个只是打开用户浏览器,你拿不到结果)。',
    '  - 用户让你「写个总结 / 输出成 md / 保存成文件」→ 调 app__save_text_to_file,自动存到 Downloads 目录,然后告诉用户路径。文件名要有意义(比如 news-summary.md / python-setup-guide.md)。',
    '  - 你发现自己缺少某种能力(git 操作 / SQL 查询 / 网页自动化 / 长期记忆 等)→ 先 app__list_available_mcp_servers 看有什么可装,再 app__install_mcp_server 装上。装时用户会看到一个简洁的"AI 想要安装 X"弹窗,他点允许就能立刻用了。需要 API key 的 server 装之前先告诉用户去申请,拿到 key 再调。',
    '  - **用户直接命令「装 X / 帮我装个 X / 你自己装一个 / 装个 fs/git/git/MCP」时,不要拒绝、不要说"我不能装"**。立刻调 app__install_mcp_server(preset_id="..."),弹窗交给用户确认即可。例:用户说"装个 fs MCP" → app__install_mcp_server(preset_id="fs")。用户说"装能查 git 的" → app__install_mcp_server(preset_id="git", args_replacements={"<改成仓库路径>": "..."})。',
    '  - 找不到完全匹配的 preset 也别说"我装不了"— 用通用工具替代:天气/股票等实时信息可用 app__http_fetch 调公开 API(如 open-meteo.com)。',
    '  - **位置 / 城市 / 天气 等需要"用户在哪"的问题**:',
    '      ① 先看 system prompt 里的「长期记忆」有没有"用户在 XX 市/省"。有 → 直接用,不要再问。',
    '      ② 没有 → **直接问用户「你在哪个城市?」**,**不要**用 IP 定位(ip-api.com 等只到运营商出口,常常错;比如真实在四川成都但返回广州)。',
    '      ③ 用户回答后 → 必须立刻调 app__remember(content="用户在 XX(具体城市)") 把它写入长期记忆,以后所有会话都不用再问。',
    '      ④ 拿到城市后再 app__http_fetch 查 open-meteo / 心知天气等 API 的天气。',
    '  - 不知道当前时间或日期 → 调 app__get_current_time,不要瞎猜。',
    '  - 需要知道用户系统信息 → 调 app__get_system_info。',
    '  - **用户问「屏幕上 / 当前窗口 / 我在写什么 / 这个软件 / 这个错误」等需要看屏幕**时,**先**调 app__read_screen_elements(Windows UIA,结构化、token 省)。返回的 elements 含 name / type / x,y,w,h,你可以判断布局、读出文字、理解用户在干什么。**不要**因此调 app__http_search。',
    '  - **如果 read_screen_elements 返回的 elementsCount 很少(< 10)、或者只有 Pane / Document / Page 等空泛控件**,说明当前应用是 Electron / CEF / 自绘 GUI(B站客户端、QQ、微信、抖音、网易云、各类小程序),UIA 读不到内容。这时**改用** app__read_screen_text 截图 OCR 拿屏幕文字。两个工具配合用 — 先 elements,看不到内容再 OCR。',
    '  - app__read_screen_text 只识别**文字**,不识别图像内容。如果用户问"这个图里的人是谁 / 这是什么风景"等需要看图,告诉用户:这需要切换到支持视觉的模型(如 deepseek-vl2 / qwen-vl-max / gpt-4o-mini),当前模型只能读文字。',
    '  - **用户提到「浏览器 / 网页 / 当前页面 / 这个网站 / 这条对话(指浏览器内的)」时**,如果工具列表里**有** `browsermcp__*` / `chrome_mcp__*` / `mcp_chrome__*` / `chrome__*` 等浏览器工具,**必须优先用它们**,不要再依赖 app__read_screen_elements。原因:read_screen_elements 走 UIA,**只能拿到浏览器外壳(标签栏 / 地址栏)**,**拿不到网页内嵌的 DOM 文本**(DeepSeek 对话内容 / 网页正文等)。而 browser MCP 工具直接读已登录页面的真实 DOM,这才是用户要的。',
    '  - 如果你已经调过 read_screen_elements 看到了浏览器外壳但没看到网页正文,**不要**告诉用户"被屏障挡住了 / 失联了":应当**改用** browser MCP 工具(若存在)。如果工具列表里**确实没有**浏览器 MCP 工具,再如实告诉用户"我装的工具读不了网页内嵌内容,请帮我装 BrowserMCP 或 Chrome MCP / 或把内容复制给我"。',
    '  - **Puppeteer (`puppeteer__*`) 是最后手段**:它启动的是独立空白 Chromium,**不共享**用户当前浏览器的登录态/标签页。**禁止**把 Puppeteer 当作"读用户当前浏览器"的工具。优先级:`browsermcp__*` > `chrome_mcp__*` / `mcp_chrome__*` > `chrome__*` >> `puppeteer__*`(只在前面都没有、且确实只需要访问公开网页时才用 puppeteer)。',
    '  - 如果浏览器 MCP 工具调用失败(比如扩展没 Connect 或与 server 协议不匹配),**不要**自动 fallback 到 Puppeteer。直接告诉用户:"我连不上浏览器 MCP — 请检查扩展是否 Connect,以及桌宠端装的 server 跟浏览器端的扩展是否配套(BrowserMCP server 配 browsermcp.io 的扩展;Chrome MCP server 配 hangwin/mcp-chrome 的扩展,两套不兼容)。"',
    '  - 用户说「记住 X / 记一下 X / 我以后都... / 我喜欢 X / 我的 X 是 Y」等明确想让你长期保留的事 → 调 app__remember(content="简洁陈述句")。一句一条,不要把整段话塞进去。',
    '  - 用户说「忘掉 X / 别记着 X 了」→ 调 app__forget(match="关键词或 id")。',
    '  - 系统已经把现有长期记忆放进了你的 system prompt(如果存在),你回答时可自然带入,不需要专门强调"我记得你..."。',
    buildSkillGuide(agentSkillsEnabled),
    '  - 调用前不必征求许可;带 mutating 的工具会由用户在 UI 弹框确认。',
    '  - 工具失败时如实告诉用户错误,不要伪造内容,也不要傻反复 retry 同一个失败的工具。',
    '【输出格式 — Markdown 渲染规范】',
    '  你的回答会被 react-markdown + remark-gfm + remark-math + rehype-katex + rehype-raw + mermaid 渲染。',
    '  **所有 markdown / mermaid / latex 语法字符必须是半角(英文)**:`-` 不是中文 `,` 或全角 `-`,`>` 不是中文 `,`,`|` 不是中文竖线。',
    '',
    '  ★ 表格(GFM):',
    '      | 项目 | 值 |',
    '      | --- | --- |        ← 必须是三个英文减号',
    '      | 温度 | 19°C |',
    '    若不确定能写对,**直接用列表替代**(更稳):',
    '      - **温度**:19°C',
    '      - **湿度**:70%',
    '',
    '  ★ Mermaid 流程图 / 时序图(```mermaid 块):',
    '    - 箭头必须是 `-->`、`->`、`->>`、`-->>`(英文减号 + 大于号),**绝不能是** `,>`、`,>>`、`-,>` 这类(那是中文标点污染,必报 parse error)。',
    '    - 节点 id 用 ASCII 字母 / 数字,中文/emoji 放在节点 label 的 `[...]` 或 `{...}` 里。',
    '    - 例(流程图):',
    '        ```mermaid',
    '        graph LR',
    '          A[采集草药] --> B[研磨]',
    '          B --> C[调配]',
    '        ```',
    '    - 例(时序图):',
    '        ```mermaid',
    '        sequenceDiagram',
    '          actor 玩家',
    '          participant 商店',
    '          玩家->>商店: 购买药剂',
    '          商店-->>玩家: 发货',
    '        ```',
    '',
    '  ★ LaTeX:行内 `$E=mc^2$`,块级 `$$ ... $$`,语法标准 KaTeX。',
    '',
    '  ★ 代码块:必须带语言标记,如 ```js / ```python / ```bash,否则不高亮。',
    '',
    '  ★ GitHub Alert 块(NOTE / TIP / IMPORTANT / WARNING / CAUTION)— **必须每行 `>` 开头**:',
    '      > [!NOTE]',
    '      > 这是一个提示块,用来强调重要信息。',
    '      > [!WARNING]',
    '      > 这是一个警告。',
    '    **错误写法**:`[!NOTE]\\n这是...`(没 `>` 前缀)→ 会渲染成普通文字。',
    '',
    '  ★ HTML 片段(<details>、<sub>、<sup> 等)可用,rehype-raw 已开。',
    '',
    '  ★ 别把整段塞到一对 `**` 里(粗体过长破坏排版),也别用过多 `\\n\\n` 空行。',
    '【效率约束】总工具调用数最多 16 次。',
    '  - 同一个工具(如 http_search)失败两次 → 不要再调第三次,换思路或直接告诉用户拿不到。',
    '  - 同一个 URL 的 http_fetch 失败一次,就别再 fetch 那个 URL,换一个站。',
    '  - 用户问简单事(看新闻 / 找资料),理想路径:1 次 http_search → 1~2 次 http_fetch → 直接回答(≤ 4 次)。',
    '  - 不要 fetch 一堆 URL"以防万一",抓 1~2 篇最相关的足够。',
    '【关键 — 独立解析每条新用户消息】',
    '  - 每条新用户消息都是独立请求,**只看用户最新这一句**决定调什么工具。**不要**默认延续上一轮调过的工具或主题。',
    '  - 例:上一轮你搜"OpenAI 新闻",这一轮用户问"帮我看看 github",你应该搜/抓 GitHub 相关内容,**和 OpenAI 没关系**。',
    '  - 例:上一轮你 read_screen_elements 看屏幕了,这一轮用户说"给我输出一个 markdown 文档示例" — 这是**纯文本生成**任务,**不要**再调 read_screen_elements 或任何工具,**直接写文档**就行。',
    '【什么时候不调工具】',
    '  - 用户让你"写 X / 输出 X / 给我个 Y 示例 / 给我讲 Z / 解释一下 / 怎么做 / 写代码 / 翻译" 这种纯生成 / 纯讲解任务 → **直接用你的知识回答,不要调任何工具**(除非用户明确说"先帮我查 / 看看现状")。',
    '  - 用户跟你聊天 / 闲聊 / 表达情绪 → 不调工具,正常聊天。',
    '  - 工具只服务于"获取你不知道的信息(实时数据 / 用户本地状态)"或"对外部系统执行操作"。纯输出题不需要工具。',
    '【复用上一轮工具结果 — 别傻重复】',
    '  - 在调任何工具前,先回顾对话历史里的 tool 消息(role=tool 的内容)。如果用户这一轮问的事**已经在上一轮工具结果里有答案**,直接基于那个内容回答,不要重复调同一个工具。',
    '  - 触发重新调的条件(三选一):',
    '      ① 用户明说「重新搜 / 再搜一次 / 刷新一下 / 最新的」',
    '      ② 用户问的虽然在同一网站但角度/关键词不同(如上轮看 GitHub 趋势,这轮要 React 仓库列表)',
    '      ③ 上轮工具结果是错误/空的',
    '  - 例:上轮用户问"看看最近的 GitHub 项目",你 fetch 了 https://github.com/trending。这轮用户又问"再帮我看看 github 项目",**直接复用上轮 trending 内容**回答,不要再 fetch 一次。',
    '  - 例:上轮 fetch 了 trending,这轮用户问"那个 vercel/next.js 仓库怎样",**这是新角度**,需要 fetch 该仓库 README。',
    '  - 用户提到具体网站时,优先直接 http_fetch 那个网站的对应页面,不要瞎搜:',
    '      · GitHub 趋势 / 热门开源 → http_fetch("https://github.com/trending") 或 https://github.com/trending/{lang}',
    '      · GitHub 某个仓库 → http_fetch("https://github.com/{owner}/{repo}")',
    '      · 知乎热门 → http_fetch("https://www.zhihu.com/hot")',
    '      · B站热门 → http_fetch("https://www.bilibili.com/v/popular/all/")',
    '      · Hacker News → http_fetch("https://news.ycombinator.com/")',
    '      · 微博热搜 → http_fetch("https://s.weibo.com/top/summary")',
    '  - 不确定哪个网站时再 http_search,把用户的关键词原样作为 query(不要自己加"新闻 趣事"等无关词)。',
  ].join('\n');
}

/** MCP tool + builtin tool → OpenAI tools 参数。
 *  generalAssistEnabled=false 时过滤掉 app__delegate_to_model — 不让 AI 看到 / 不让 AI 调。 */
async function buildOpenAITools(generalAssistEnabled: boolean): Promise<unknown[]> {
  if (!mcpManager.hasAnyTools()) return [];
  const all = await mcpManager.listAllTools();
  const tools = generalAssistEnabled
    ? all
    : all.filter((t) => t.name !== 'app__delegate_to_model');
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

/** MCP result content → 文本字符串(喂给 LLM role=tool content) */
function mcpResultToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object' && 'text' in item) {
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      } else if (typeof item === 'string') {
        parts.push(item);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** 上限:LLM 一次请求里最多允许连续调几次 tool(防无限循环)。
 *  16 在大部分场景够用(搜索 1-2 次 + fetch 2-3 次 + 装 server + read_file 几次,通常 < 10)。
 *  到达上限时不会直接报错,而是再给 AI 一次"不带 tools"的机会让它总结现有信息收敛。 */
const MAX_TOOL_ROUNDS = 16;

// ---------------- 视觉辅助 ----------------

/** 已知支持视觉的 model 名子串(小写)。命中即视为支持图片输入,**不**走视觉辅助。
 *  保守策略 — 漏判(实际能识图但不在表里)只是多调一次辅助;误判(实际不能识图但命中)
 *  会让请求 4xx 报错给用户。所以只列文档明确支持图片的稳定关键词。 */
const VISION_MODEL_HINTS = [
  'vl', 'vision',
  'gpt-4o', 'gpt-4-turbo', 'gpt-5',
  'claude-3', 'claude-sonnet', 'claude-opus',
  'gemini',
  'pixtral', 'llava',
  'glm-4v', 'glm-4.1v', 'glm-4.5v',
  'step-1v', 'step-1o', 'step-3',
  'hunyuan-vision',
  'yi-vl', 'yi-vision',
];

function modelLikelyVision(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return VISION_MODEL_HINTS.some((k) => n.includes(k));
}

interface VisionAssistant {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 给思考气泡显示用,如「指定:OpenAI/gpt-4o」「兜底:智谱/glm-4v-plus」 */
  source: string;
}

/** 选一个能识图的辅助。优先用户手动指定,其次扫所有 profile 关键词匹配兜底。
 *  返回 null 表示当前配置下找不到。 */
function pickVisionAssistant(cfg: AppConfig): VisionAssistant | null {
  const va = cfg.visionAssist;
  if (!va?.enabled) return null;
  const profiles = cfg.providerProfiles ?? [];
  // 1. 用户手动指定
  if (va.assistantProfileId && va.assistantModel) {
    const p = profiles.find((x) => x.id === va.assistantProfileId);
    if (p && p.baseURL && p.apiKey) {
      return {
        baseURL: p.baseURL,
        apiKey: p.apiKey,
        model: va.assistantModel,
        source: `指定:${p.name}/${va.assistantModel}`,
      };
    }
  }
  // 2. 兜底:遍历所有 profile 的 modelPresets,关键词匹配第一个
  if (va.fallbackAcrossAll) {
    for (const p of profiles) {
      if (!p.baseURL || !p.apiKey) continue;
      const m = (p.modelPresets ?? []).find((x) => modelLikelyVision(x));
      if (m) {
        return {
          baseURL: p.baseURL,
          apiKey: p.apiKey,
          model: m,
          source: `兜底:${p.name}/${m}`,
        };
      }
    }
  }
  return null;
}

/** 注入"今天是 X 年 X 月 X 日 周 X"到 system,解决 LLM 用训练截止时间推理"最新"的问题。
 *  - 用户问「最新 X」时 AI 才会搜带正确年份的关键词
 *  - 也避免 AI 答出「现在是 2024 年」这种过时表述
 *  本机 toLocaleDateString('zh-CN') 已经给中文格式,够用。 */
function buildTodayHint(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return (
    `[今天是 ${y}-${m}-${day}(周${week})]\n` +
    `用户问「最新 / 最近 / 现在」相关的话题时,以这个日期为准。` +
    `调用搜索类工具(http_search 等)时,如果话题是「最新 X」,搜索词请加上当前年份(${y})或「${y} 最新」,` +
    `避免拿到过时结果。回答里也不要说"现在是 ${y - 1} 年"这种过期话。`
  );
}

/** 选 generalAssist 的兜底模型 — 主模型整轮报错时启用。
 *  优先用户手动指定的 assistantProfileId/assistantModel,其次 fallbackAcrossAll
 *  时从所有可用 profile 里挑一个**不是当前主模型自己**的(避免拿主模型再试一次还是同样错)。
 *  返回 null = 没启用 / 没合适候选。 */
function pickGeneralAssistant(cfg: AppConfig): VisionAssistant | null {
  const ga = cfg.generalAssist;
  if (!ga?.enabled) return null;
  const profiles = cfg.providerProfiles ?? [];
  // 1. 用户手动指定
  if (ga.assistantProfileId && ga.assistantModel) {
    const p = profiles.find((x) => x.id === ga.assistantProfileId);
    if (p && p.baseURL && p.apiKey) {
      // 排除"指定的辅助 = 当前主模型自己"的退化情形
      const sameAsPrimary = p.baseURL === cfg.baseURL && ga.assistantModel === cfg.model;
      if (!sameAsPrimary) {
        return {
          baseURL: p.baseURL,
          apiKey: p.apiKey,
          model: ga.assistantModel,
          source: `指定:${p.name}/${ga.assistantModel}`,
        };
      }
    }
  }
  // 2. 兜底:扫所有 profile 的 modelPresets 找第一个非自己
  if (ga.fallbackAcrossAll) {
    for (const p of profiles) {
      if (!p.baseURL || !p.apiKey) continue;
      for (const m of p.modelPresets ?? []) {
        if (p.baseURL === cfg.baseURL && m === cfg.model) continue;
        return {
          baseURL: p.baseURL,
          apiKey: p.apiKey,
          model: m,
          source: `兜底:${p.name}/${m}`,
        };
      }
    }
  }
  return null;
}

/** 主模型整轮失败时的最后一根稻草 — 用 generalAssist 选出的辅助模型纯文本收敛回答一次。
 *  关键设计:
 *    - 不传 tools:fallback 模型只负责"基于现有上下文给个回答",不再调工具
 *    - 在 chunk 前先推一段 thinking 提示让用户知道发生了什么
 *    - fallback 自身也失败 → 把"主+辅"两条错误一并 ai:error 出去,便于排查
 *  返回 true = 已处理(无论成功失败,调用方不要再 ai:error);false = 没启用 / 没候选。 */
async function tryGeneralAssistFallback(
  cfg: AppConfig,
  win: BrowserWindow,
  reqId: string,
  running: ChatMessage[],
  primaryError: string,
): Promise<boolean> {
  const assistant = pickGeneralAssistant(cfg);
  if (!assistant) return false;
  win.webContents.send('ai:chunk', {
    reqId,
    delta:
      `\n⚠ 主模型(${cfg.model})出错:${primaryError}\n` +
      `📡 启用模型辅助兜底,正用 ${assistant.source} 接管…\n\n`,
    kind: 'thinking',
  });
  try {
    await streamOneTurn(
      win,
      reqId,
      assistant.baseURL,
      assistant.apiKey,
      assistant.model,
      running,
      null, // 不带 tools — 收敛专用
      () => {
        // chunks 已通过 webContents 推送
      },
    );
    win.webContents.send('ai:done', { reqId });
  } catch (e) {
    win.webContents.send('ai:error', {
      reqId,
      message:
        `主模型失败:${humanizeApiError(primaryError)}\n\n` +
        `辅助模型(${assistant.source})也失败:${humanizeApiError((e as Error).message)}`,
    });
  }
  return true;
}

/** 把 LLM 后端返回的英文堆栈错误翻译成中文可读提示并附操作建议。
 *  - 不丢原文(`原:...` 拼在末尾,方便用户/我们排查)
 *  - 命中常见 case:context 过长 / 不识图 / 401 / 429 / 网络超时 / 模型不存在 / JSON parse
 *  - 没命中:原文 + 通用建议 */
function humanizeApiError(raw: string): string {
  const r = raw || '';
  const lower = r.toLowerCase();
  const head = (msg: string) => `${msg}\n\n— 原始报错:${r}`;
  if (
    /(context length|maximum context|too many tokens|exceed.*tokens|too long.*input|prompt is too long)/i.test(r) ||
    /tokens?\)?\.?\s*(?:however|but)/i.test(r)
  ) {
    return head(
      '⚠ 对话太长,超出了主模型的上下文上限。\n' +
        '➡ 建议:点对话框的「🆕 新话题」按钮(或按 Ctrl+L)开启新一轮,或新建会话。',
    );
  }
  if (/(unknown variant.*image_url|expected.*text.*image_url|does not support.*image|vision.*not.*support)/i.test(r)) {
    return head(
      '⚠ 当前主模型不支持图片输入。\n' +
        '➡ 建议:去 设置 → AI → 视觉辅助 启用并指定一个识图模型(如 智谱 GLM-4V、OpenAI gpt-4o);' +
        '或直接把主模型换成支持 vision 的型号。',
    );
  }
  if (lower.includes('401') || /unauthorized|invalid.*api.*key|api key.*invalid/i.test(r)) {
    return head('⚠ API Key 无效或已过期。\n➡ 建议:去 设置 → AI 检查 baseURL / apiKey 是否正确。');
  }
  if (lower.includes('403') || /forbidden|permission denied/i.test(r)) {
    return head('⚠ 服务端拒绝访问(403)。\n➡ 建议:可能是 IP 限制 / 账户欠费 / 模型未授权,去服务商控制台查。');
  }
  if (lower.includes('429') || /rate limit|too many requests|quota/i.test(r)) {
    return head('⚠ 调用过于频繁或超出配额。\n➡ 建议:稍等 30 秒重试;长期超出请到服务商加额度或升级套餐。');
  }
  if (/timeout|etimedout|econnreset|enotfound|network|fetch failed|getaddrinfo/i.test(r)) {
    return head('⚠ 网络超时或连接失败。\n➡ 建议:检查网络 / 代理;若用国外服务(OpenAI、Anthropic)确保翻墙稳定。');
  }
  if (lower.includes('404') || /model.*not.*found|no such model|invalid model/i.test(r)) {
    return head('⚠ 模型不存在或未启用。\n➡ 建议:去 设置 → AI 检查 model 名称是否拼写正确,或换成 profile 里的预设模型。');
  }
  if (/json|parse|deserialize/i.test(r) && /messages\[\d+\]/i.test(r)) {
    return head(
      '⚠ 历史消息格式不被当前模型接受(可能是老数据残留)。\n' +
        '➡ 建议:点「🆕 新话题」开新一轮,或直接新建会话绕过老数据。',
    );
  }
  if (lower.includes('500') || lower.includes('502') || lower.includes('503') || /service unavailable|server error/i.test(r)) {
    return head('⚠ 服务端临时故障。\n➡ 建议:稍等几秒重试;持续失败请去服务商状态页查看。');
  }
  return r;
}

/** 估算单条消息的字符数(粗略代理 tokens)— content 可能是 string、array、null;
 *  tool_calls 的 arguments 也算进去(它们也会送给 LLM)。 */
function estimateMsgChars(m: ChatMessage): number {
  let n = 0;
  if (typeof m.content === 'string') n += m.content.length;
  else if (Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p.type === 'text') n += p.text.length;
      else if (p.type === 'image_url') n += 200; // 占位估算,真正图片走多模态路径
    }
  }
  if (m.reasoning_content) n += m.reasoning_content.length;
  if (m.tool_calls) {
    for (const c of m.tool_calls) n += (c.function?.arguments?.length ?? 0) + (c.function?.name?.length ?? 0);
  }
  return n;
}

/** 自动上下文裁剪 — 防止长对话累积撞模型 context 上限(用户已撞过 1098k tokens 的 400)。
 *  策略:
 *    - 总字符数 ≤ 预算 → 原样返回
 *    - 超过 → 从尾部往前累加,装下多少留多少;丢掉的早期对话用一条 system 占位说明
 *    - 切点必须落在 user 消息(否则会切断 assistant↔tool_call↔tool 三件套配对,LLM 会 400)
 *  预算用字符做粗略代理,中文 1 字符 ≈ 1.5 tokens,100k 字符 ≈ 50k~150k tokens,
 *  对市面主流模型(32k~200k context)留有充足安全垫。极端情况(连最新一条都装不下)
 *  保留最后一条 user,让 LLM 至少还能拿到当前问题。 */
const CONTEXT_CHAR_BUDGET = 100_000;
function trimContextIfNeeded(messages: ChatMessage[]): {
  messages: ChatMessage[];
  trimmed: number;
} {
  const total = messages.reduce((s, m) => s + estimateMsgChars(m), 0);
  if (total <= CONTEXT_CHAR_BUDGET) return { messages, trimmed: 0 };
  // 从尾部累加
  let acc = 0;
  let keepFromIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMsgChars(messages[i]);
    if (acc > CONTEXT_CHAR_BUDGET) break;
    keepFromIdx = i;
  }
  // 切点不能落在 tool / assistant(否则失去 tool_call 上下文,LLM 会拒)→ 往后挪到下一个 user
  while (keepFromIdx < messages.length && messages[keepFromIdx].role !== 'user') {
    keepFromIdx++;
  }
  // 极端:连最后一条都装不下 — 至少保留最后一条 user(若没有 user 就丢全部空返,外层会兜底)
  if (keepFromIdx >= messages.length) {
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return { messages, trimmed: 0 };
    return {
      messages: [messages[lastUserIdx]],
      trimmed: messages.length - 1,
    };
  }
  const dropped = keepFromIdx;
  if (dropped === 0) return { messages, trimmed: 0 };
  const summary: ChatMessage = {
    role: 'system',
    content:
      `[已自动折叠最早 ${dropped} 条对话以避免上下文超长]` +
      `如需回顾早期内容,请用户点对话框的「🆕 新话题」按钮(Ctrl+L)开新一轮,` +
      `或在历史模式翻看完整记录。`,
  };
  return { messages: [summary, ...messages.slice(keepFromIdx)], trimmed: dropped };
}

/** 仅把"最新一条 user"的 image_url part 剥成 `[屏幕截图]` 文本。
 *  用于:主模型不识图 + 视觉辅助未启用时 — 不能塞图给主模型(API 会 400),
 *  改为剥图后让 AI 自己调读屏/读浏览器工具间接获取屏幕内容。 */
function stripImagesFromLatestUser(messages: ChatMessage[]): ChatMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;
  const m = messages[lastUserIdx];
  if (!Array.isArray(m.content)) return messages;
  const textParts: string[] = [];
  let imgCount = 0;
  for (const p of m.content) {
    if (p.type === 'text') textParts.push(p.text);
    else if (p.type === 'image_url') imgCount++;
  }
  const placeholder = imgCount > 0 ? `[屏幕截图 ×${imgCount}]` : '';
  const merged = [textParts.join(' ').trim(), placeholder].filter(Boolean).join('\n\n') || '[图]';
  const out = [...messages];
  out[lastUserIdx] = { ...m, content: merged };
  return out;
}

/** 把"除最新一条 user 外"的所有历史 user/assistant 消息里的 image_url part 剥成纯文本。
 *  - 渲染端发送时已经把当前轮 image_url 持久化成 `[图 N]` 文本占位,但老 sessions
 *    可能在 localStorage 里残留了 image_url(早期版本没做替换)。
 *  - 主模型不识图时,这些遗留 image_url 会让 API 直接报 400 unknown variant。
 *  - 因此进 streamChat 时统一兜底:历史轮的 image part 一律替换为 `[图]` 占位,
 *    最后一条 user 的图保留(可能是当前轮真要识图的内容,由 visionAssist 处理)。
 *  返回新数组,原 messages 不动。 */
function stripHistoryImages(messages: ChatMessage[]): ChatMessage[] {
  // 找最后一条 user 的下标 — 它的图保留,其余 user/assistant 全剥
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (i === lastUserIdx) return m;
    if (!Array.isArray(m.content)) return m;
    // 把 array content 里的 image_url 替换成 [图] 文本,text 原样保留
    const textParts: string[] = [];
    for (const p of m.content) {
      if (p.type === 'text') textParts.push(p.text);
      else if (p.type === 'image_url') textParts.push('[图]');
    }
    return { ...m, content: textParts.join(' ').trim() || '[图]' };
  });
}

/** 检查 messages 里最后一条 user 是否含 image_url part(只看最后一条,
 *  历史里的图无所谓——主模型没解析能力时本来就只能看到文本占位)。 */
function lastUserHasImage(messages: ChatMessage[]): ChatContentPart[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) {
      return m.content;
    }
    return null;
  }
  return null;
}

/** 调辅助 model 一次性识图,非流式,返回描述文本。失败返回 null,不阻断主流程。 */
function describeImagesWithAssistant(
  assistant: VisionAssistant,
  userContent: ChatContentPart[],
): Promise<string | null> {
  const url = assistant.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({
    model: assistant.model,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          '你是图像描述助手。请用中文客观、详细地描述用户提供的每张图片:' +
          '画面主体、文字内容、颜色、构图、可见的关键信息等。' +
          '不要回答用户文字里的其他问题,只描述图。',
      },
      { role: 'user', content: userContent },
    ],
  });
  return new Promise((resolve) => {
    const request = net.request({ method: 'POST', url });
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Authorization', `Bearer ${assistant.apiKey}`);
    let buf = '';
    let status = 0;
    request.on('response', (resp) => {
      status = resp.statusCode;
      resp.on('data', (b: Buffer) => {
        buf += b.toString('utf-8');
      });
      resp.on('end', () => {
        if (status >= 400) {
          console.warn('[vision-assist] HTTP', status, buf.slice(0, 200));
          resolve(null);
          return;
        }
        try {
          const j = JSON.parse(buf);
          const text = j?.choices?.[0]?.message?.content;
          resolve(typeof text === 'string' && text.trim() ? text.trim() : null);
        } catch (e) {
          console.warn('[vision-assist] parse failed:', (e as Error).message);
          resolve(null);
        }
      });
      resp.on('error', () => resolve(null));
    });
    request.on('error', (err) => {
      console.warn('[vision-assist] request error:', err.message);
      resolve(null);
    });
    request.write(body);
    request.end();
  });
}

/** 通用模型辅助启用时,把所有可用 profile 的 modelPresets 列出来,
 *  让 AI 知道身边都有谁可以求助 + 默认辅助是谁,然后由 AI 自己决定要不要调
 *  app__delegate_to_model。 */
function buildAvailableModelsList(cfg: AppConfig): string {
  const profiles = cfg.providerProfiles ?? [];
  const usable = profiles.filter((p) => p.baseURL && p.apiKey);
  if (usable.length === 0) return '';
  const ga = cfg.generalAssist;
  const lines: string[] = ['【模型辅助 — 可委托的同事清单】'];
  for (const p of usable) {
    const presets = p.modelPresets ?? [];
    const ms = presets.length > 0 ? presets.join(', ') : p.model || '(未填 model)';
    lines.push(`  - profile_id="${p.id}"(${p.name}):${ms}`);
  }
  if (ga?.assistantProfileId && ga.assistantModel) {
    lines.push(`  默认辅助:profile_id="${ga.assistantProfileId}",model="${ga.assistantModel}"`);
    lines.push(
      '  → 调 app__delegate_to_model 时 profile_id/model 留空,系统会自动用默认辅助。' +
        '只在你判断默认辅助也搞不定这个具体任务时,才显式从上面清单挑别的。',
    );
  } else {
    lines.push(
      '  (用户没在设置里配默认辅助 model)' +
        (ga?.fallbackAcrossAll
          ? '— 系统会自动从清单里挑第一个可用的当辅助;你也可显式 profile_id+model 指定。'
          : '— 调 app__delegate_to_model 时必须自己显式 profile_id+model。'),
    );
  }
  lines.push(
    '何时调用:仅当你判断自己确实搞不定(领域陌生 / 推理深度不足 / 上下文超出 等)时才调,且每次只调一次给一个目标。一般任务自己直接答即可,不要滥用。',
  );
  return lines.join('\n');
}

/** 把最后一条 user 消息的 image_url 替换成「文字 + 辅助识图描述」,
 *  让不识图的主模型也能基于描述继续回答。返回新的 messages 数组,原数组不变。 */
function inlineVisionDescription(
  messages: ChatMessage[],
  description: string,
): ChatMessage[] {
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'user') continue;
    if (!Array.isArray(m.content)) break;
    const texts = m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    const merged =
      (texts ? texts + '\n\n' : '') +
      `[视觉辅助模型看到的图片内容]\n${description}`;
    out[i] = { ...m, content: merged };
    break;
  }
  return out;
}

export async function streamChat(
  win: BrowserWindow,
  reqId: string,
  messages: ChatMessage[],
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
    win.webContents.send('ai:error', {
      reqId,
      message: 'AI 未配置,请先在 设置 里填 baseURL / apiKey / model',
    });
    return;
  }

  // 顶层兜底:streamChat 整个函数体里任何同步/异步错误都必须通过 ai:error 发回渲染端。
  // 否则错误就这么吞掉,渲染端 streaming=true 永远不变 → UI 卡在"思考中"或回到输入态
  // 但 pet 状态条仍显示 thinking(用户实际遇到的现象)。
  try {
    await streamChatInner(win, reqId, messages, cfg);
  } catch (e) {
    win.webContents.send('ai:error', {
      reqId,
      message: humanizeApiError((e as Error).message || String(e)),
    });
  }
}

/** streamChat 的内部主体 — 拆出来好让外层 streamChat 用单一 try/catch 兜全部错误。 */
async function streamChatInner(
  win: BrowserWindow,
  reqId: string,
  messages: ChatMessage[],
  cfg: AppConfig,
): Promise<void> {
  // 兜底:历史轮里残留的 image_url part 一律剥成 [图] 文本占位。最新一条 user 的图保留,
  // 由下面的视觉辅助逻辑处理。这一步避免老 sessions(早期版本未做占位替换)在主模型
  // 不识图时触发 HTTP 400 unknown variant `image_url`。
  messages = stripHistoryImages(messages);

  // 自动上下文裁剪 — 长对话累积超过预算时丢掉最早对话,避免撞 context 上限的 400。
  // 用户的渲染端 contextStartIdx 是手动信号;这里是底层兜底,任何情况都生效。
  const trim = trimContextIfNeeded(messages);
  if (trim.trimmed > 0) {
    messages = trim.messages;
    win.webContents.send('ai:chunk', {
      reqId,
      delta: `\n📑 对话太长,已自动折叠最早 ${trim.trimmed} 条;如需引用早期内容请点🆕新话题。\n\n`,
      kind: 'thinking',
    });
  }

  // 视觉辅助预处理 — 主模型疑似不识图但用户发了图,先用辅助模型转文字描述
  if (
    cfg.visionAssist?.enabled &&
    !modelLikelyVision(cfg.model) &&
    lastUserHasImage(messages)
  ) {
    const assistant = pickVisionAssistant(cfg);
    if (assistant) {
      win.webContents.send('ai:chunk', {
        reqId,
        delta: `📷 当前主模型不识图,正在让视觉辅助模型(${assistant.source})先看图…\n`,
        kind: 'thinking',
      });
      const userContent = lastUserHasImage(messages);
      if (userContent) {
        const desc = await describeImagesWithAssistant(assistant, userContent);
        if (desc) {
          messages = inlineVisionDescription(messages, desc);
          win.webContents.send('ai:chunk', {
            reqId,
            delta: `✓ 识图完成,继续由主模型回答。\n\n`,
            kind: 'thinking',
          });
        } else {
          win.webContents.send('ai:chunk', {
            reqId,
            delta: `⚠ 视觉辅助模型调用失败,改由主模型直接处理(可能会报错)。\n`,
            kind: 'thinking',
          });
        }
      }
    } else {
      win.webContents.send('ai:chunk', {
        reqId,
        delta: `⚠ 检测到图片输入但当前主模型可能不识图;请在 AI 设置 → 视觉辅助 里指定一个识图模型,或开启「全员兜底」。\n`,
        kind: 'thinking',
      });
    }
  }

  // 拼 system
  const sysPrompt = getActiveSystemPrompt(cfg);
  const memBlock = (cfg.memory ?? '').trim();
  const sysParts: string[] = [];
  // 注入"今天日期" — 否则 LLM 用训练截止时的旧知识推理"最新 X",连带搜索词也偏旧。
  // 例:用户问"最新奥特曼",AI 知道是 2026 才会搜"2026 奥特曼"而不是用训练时的旧概念。
  sysParts.push(buildTodayHint());
  if (sysPrompt) sysParts.push(sysPrompt);
  if (memBlock) sysParts.push(`[长期记忆 — 关于用户的习惯 / 偏好 / 上下文,需要时参考]\n${memBlock}`);
  // AI 自己通过 app__remember / app__forget 维护的动态记忆 — 文件存在用户级目录,
  // 跨会话、跨模型一致。每次对话注入,确保任何模型/会话都能看到。
  const dynamicMem = formatMemoriesForPrompt();
  if (dynamicMem) sysParts.push(dynamicMem);

  // 只有 mcp.enabled 才带 tools(builtin 永远在,server 看用户配置)
  const generalAssistEnabled = cfg.generalAssist?.enabled === true;
  const tools: unknown[] = cfg.mcp?.enabled
    ? await buildOpenAITools(generalAssistEnabled)
    : [];
  const confirmWrites = cfg.mcp?.confirmWrites !== false;

  // 在 system 末尾追加工具使用引导,让 AI 知道自己能调用什么、什么时候调
  if (tools.length > 0) {
    sysParts.push(buildToolGuide(tools, cfg.agentSkills?.enabled !== false));
  }
  // 通用模型辅助启用 → 把可调度的 model 清单注入 system,让 AI 知道身边有哪些"同事"可借力
  if (generalAssistEnabled) {
    const list = buildAvailableModelsList(cfg);
    if (list) sysParts.push(list);
  }
  const fullSys = sysParts.join('\n\n');

  const running: ChatMessage[] = fullSys
    ? [{ role: 'system', content: fullSys }, ...messages]
    : [...messages];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const turn = await streamOneTurn(
        win,
        reqId,
        cfg.baseURL,
        cfg.apiKey,
        cfg.model,
        running,
        tools.length > 0 ? tools : null,
        () => {
          // 每个 chunk 已经通过 webContents 推出;这里不需再做事
        },
      );

      // 无 tool_calls → 正常结束
      if (turn.toolCalls.length === 0) {
        win.webContents.send('ai:done', { reqId });
        return;
      }

      // 把 assistant + tool_calls 加入历史。DeepSeek thinking 模型要求
      // reasoning_content 也带回去,否则下一轮请求会 400
      running.push({
        role: 'assistant',
        content: turn.assistantText || '',
        tool_calls: turn.toolCalls,
        ...(turn.reasoningContent ? { reasoning_content: turn.reasoningContent } : {}),
      });

      // 按顺序执行每个 tool call(串行 — 写操作避免并发冲突)
      for (const call of turn.toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // 参数 JSON 坏了 — 把错误作为 tool 结果喂回去,让 LLM 重试
          running.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: `Error: failed to parse arguments JSON: ${call.function.arguments}`,
          });
          continue;
        }

        // 工具调用事件:开始
        const callIdShort = call.id || 'call-' + Math.random().toString(36).slice(2, 8);
        win.webContents.send('mcp:tool-event', {
          reqId,
          callId: callIdShort,
          stage: 'call',
          toolName: call.function.name,
          args: parsedArgs,
        });

        // 写操作需要用户确认。例外:用户在「主动互动」里开了 autoReadScreen,
        // 那就直接放行 read_screen_elements(否则每次主动互动都弹窗,用户体验糟糕)。
        // 同理 autoReadBrowser 时,放行 browsermcp / chrome_mcp / mcp_chrome 系列的读操作。
        const proCfg = getProactiveConfig(cfg);
        const toolName = call.function.name;
        const isReadScreen =
          toolName === 'app__read_screen_elements' || toolName === 'app__read_screen_text';
        const isBrowserRead =
          /^(browsermcp|chrome_mcp|mcp_chrome|chrome)__/i.test(toolName) &&
          /(get|read|list|inspect|snapshot|content|screenshot|page)/i.test(toolName);
        const proactiveAllowed =
          (isReadScreen && proCfg.autoReadScreen) ||
          (isBrowserRead && proCfg.autoReadBrowser);
        // 用户在「设置 → 模型辅助」勾了「调用时不再提示我」 → delegate 直接放行
        const delegateAutoAllowed =
          toolName === 'app__delegate_to_model' && cfg.generalAssist?.skipConfirm === true;

        if (
          confirmWrites &&
          !proactiveAllowed &&
          !delegateAutoAllowed &&
          mcpManager.isMutating(call.function.name)
        ) {
          const ok = await askUserConfirm(win, call.function.name, parsedArgs);
          if (!ok) {
            const denyMsg = `User denied execution of tool "${call.function.name}".`;
            running.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: denyMsg,
            });
            win.webContents.send('mcp:tool-event', {
              reqId,
              callId: callIdShort,
              stage: 'error',
              toolName: call.function.name,
              error: denyMsg,
            });
            continue;
          }
        }

        // 调 MCP 工具。
        try {
          const res = await mcpManager.callTool(call.function.name, parsedArgs);
          const text = mcpResultToText(res.content);
          running.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: res.isError ? `[tool error] ${text}` : text,
          });
          win.webContents.send('mcp:tool-event', {
            reqId,
            callId: callIdShort,
            stage: res.isError ? 'error' : 'result',
            toolName: call.function.name,
            result: text.slice(0, 2000), // 防 UI 卡死,截短
          });
        } catch (e) {
          const errMsg = (e as Error).message;
          running.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: `Error calling tool: ${errMsg}`,
          });
          win.webContents.send('mcp:tool-event', {
            reqId,
            callId: callIdShort,
            stage: 'error',
            toolName: call.function.name,
            error: errMsg,
          });
        }
      }
      // 循环下一轮
    }

    // 到达 round 上限还没收敛 — 给 AI 最后一次"不带 tools"的机会,让它总结已有信息直接回答用户。
    // 这样用户能拿到一个基于现有数据的回答,而不是干巴巴的报错。
    running.push({
      role: 'user',
      content:
        `[系统提示] 你已经连续调用了 ${MAX_TOOL_ROUNDS} 轮工具,达到上限。` +
        '现在不要再调工具,基于上面已有的工具结果直接给出最终答案;' +
        '如果信息不够,如实告诉用户"目前能查到的就这些"并简要说明卡在哪。',
    });
    try {
      await streamOneTurn(
        win,
        reqId,
        cfg.baseURL,
        cfg.apiKey,
        cfg.model,
        running,
        null, // 不传 tools,强制纯文本收敛
        () => {
          // chunks 已被推送到渲染端
        },
      );
      win.webContents.send('ai:done', { reqId });
    } catch (e) {
      const rawMsg = `工具调用超过 ${MAX_TOOL_ROUNDS} 轮且收敛失败:${(e as Error).message}`;
      const handled = await tryGeneralAssistFallback(cfg, win, reqId, running, rawMsg);
      if (!handled) {
        win.webContents.send('ai:error', { reqId, message: humanizeApiError(rawMsg) });
      }
    }
  } catch (e) {
    const rawMsg = (e as Error).message;
    const handled = await tryGeneralAssistFallback(cfg, win, reqId, running, rawMsg);
    if (!handled) {
      win.webContents.send('ai:error', { reqId, message: humanizeApiError(rawMsg) });
    }
  }
}
