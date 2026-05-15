/**
 * MCP (Model Context Protocol) 客户端封装。
 *
 * 设计:
 *  - 全局持一个 McpManager 单例;根据 config.mcp 启动 / 重启 / 停止官方
 *    server-filesystem 子进程(stdio transport)。
 *  - 暴露统一的 tool 列表(合并多个 server,name 加 server 前缀避免冲突)。
 *  - 提供 callTool(prefixedName, args),根据前缀路由到对应 server client。
 *
 * 未来扩展(本次未实现):可在 McpConfig 里加更多 server 定义(git / sqlite 等)。
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpConfig, McpServerSpec } from './config-store.js';
import {
  listBuiltinTools,
  isBuiltinTool,
  isBuiltinMutating,
  callBuiltinTool,
} from './builtin-tools.js';

/** 扁平化后的 tool 描述(OpenAI function 格式兼容) */
export interface McpToolDesc {
  /** 带 server 前缀的 name,如 "fs__read_file" — 唯一,用于 LLM 的 tools 数组 */
  name: string;
  /** server 内部的原始 name,如 "read_file" */
  rawName: string;
  /** 归属的 server id(内部路由用) */
  serverId: string;
  description: string;
  /** JSON Schema(LLM tools 里的 function.parameters) */
  inputSchema: Record<string, unknown>;
}

interface ServerEntry {
  id: string;
  client: Client;
  transport: StdioClientTransport;
}

/** 把 MCP 原始 tool name 加上 server 前缀,保证多个 server 的 tool 不冲突。
 *  LLM 侧只看 prefixed name;我们自己内部拆分路由。 */
function prefixName(serverId: string, rawName: string): string {
  return `${serverId}__${rawName}`;
}
function splitPrefixed(prefixed: string): { serverId: string; rawName: string } | null {
  const idx = prefixed.indexOf('__');
  if (idx < 0) return null;
  return { serverId: prefixed.slice(0, idx), rawName: prefixed.slice(idx + 2) };
}

/** 判断一个 tool 是否属于"写操作" — 需要用户二次确认。
 *  用 name 正则粗匹配(MCP 还没标注 readOnly hint 的规范,只能靠惯例)。 */
export function isMutatingTool(rawName: string): boolean {
  return /write|edit|create|append|delete|move|rename|mkdir|remove/i.test(rawName);
}

export class McpManager {
  private servers = new Map<string, ServerEntry>();
  /** 上次启动用的 config snapshot,用于判断是否需要重启 */
  private lastSignature = '';

  /** 根据 config 启动 / 停止 / 重启 servers。幂等 — 相同 config 不重启 */
  async applyConfig(cfg: McpConfig | undefined): Promise<void> {
    const signature = JSON.stringify(cfg ?? null);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    // 先全部停(简单起见 — servers 启动快)
    await this.stopAll();

    if (!cfg?.enabled) return;
    for (const spec of cfg.servers ?? []) {
      if (!spec.enabled) continue;
      if (!/^[a-z0-9_]+$/i.test(spec.id)) {
        console.warn('[mcp] skip server: invalid id:', spec.id);
        continue;
      }
      try {
        await this.startServer(spec);
      } catch (e) {
        console.error(`[mcp] failed to start server "${spec.id}":`, (e as Error).message);
      }
    }
  }

  /** 按 spec 启动一个 server,注册进 this.servers。 */
  private async startServer(spec: McpServerSpec): Promise<void> {
    let command = spec.command;
    let args = spec.args.slice();
    let env: Record<string, string> = { ...process.env, ...(spec.env ?? {}) } as Record<
      string,
      string
    >;

    // 特殊值:bundled-fs — 用 Electron-as-Node 跑 node_modules 里打包的 server-filesystem
    if (spec.command === 'bundled-fs') {
      const entry = locateBundledFilesystemEntry();
      if (!entry) throw new Error('bundled @modelcontextprotocol/server-filesystem not found');
      command = process.execPath;
      args = [entry, ...spec.args];
      env = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    }

    // Windows 下 npx / uvx 等命令对应 .cmd,StdioClientTransport 底层用 cross-spawn 已处理
    const transport = new StdioClientTransport({ command, args, env });
    const client = new Client(
      { name: 'desktop-pet', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.servers.set(spec.id, { id: spec.id, client, transport });
    console.log(`[mcp] server "${spec.id}" started:`, command, args.join(' '));
  }

  async stopAll(): Promise<void> {
    for (const [id, s] of this.servers) {
      try {
        await s.client.close();
      } catch (e) {
        console.warn(`[mcp] close ${id} failed:`, (e as Error).message);
      }
    }
    this.servers.clear();
  }

  /** 所有 tool 列表 = builtin + 各 server。已带 server 前缀,LLM 直接拿来塞 tools 字段 */
  async listAllTools(): Promise<McpToolDesc[]> {
    const out: McpToolDesc[] = [];
    // builtin tools(主进程直接实现,不走子进程)
    for (const t of listBuiltinTools()) {
      out.push({
        name: t.name,
        rawName: t.rawName,
        serverId: 'app',
        description: t.description,
        inputSchema: t.inputSchema,
      });
    }
    // MCP server tools
    for (const [id, s] of this.servers) {
      try {
        const res = await s.client.listTools();
        for (const t of res.tools) {
          out.push({
            name: prefixName(id, t.name),
            rawName: t.name,
            serverId: id,
            description: t.description ?? '',
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          });
        }
      } catch (e) {
        console.warn(`[mcp] listTools ${id} failed:`, (e as Error).message);
      }
    }
    return out;
  }

  /** 调用 prefixed tool。先看是不是 builtin(app__),否则按 prefix 路由到 server。 */
  async callTool(
    prefixedName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown; isError?: boolean }> {
    if (isBuiltinTool(prefixedName)) {
      try {
        const text = await callBuiltinTool(prefixedName, args);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
    const split = splitPrefixed(prefixedName);
    if (!split) throw new Error(`invalid tool name: ${prefixedName}`);
    const s = this.servers.get(split.serverId);
    if (!s) throw new Error(`mcp server "${split.serverId}" not running`);
    const res = await s.client.callTool({ name: split.rawName, arguments: args });
    return { content: res.content, isError: (res as { isError?: boolean }).isError };
  }

  /** 是否需要二次确认(写操作)— builtin 看 mutating 字段,server 用 name regex 兜底 */
  isMutating(prefixedName: string): boolean {
    if (isBuiltinTool(prefixedName)) return isBuiltinMutating(prefixedName);
    const split = splitPrefixed(prefixedName);
    return !!split && isMutatingTool(split.rawName);
  }

  /** AI 现在是否有可用 tool 可用(builtin 永远 ≥1,所以基本只要 enabled 就 true) */
  hasAnyTools(): boolean {
    return listBuiltinTools().length > 0 || this.servers.size > 0;
  }
  /** 是否至少连上一个 MCP server(UI 显示状态用) */
  hasAnyServer(): boolean {
    return this.servers.size > 0;
  }
}

/** 定位 bundled @modelcontextprotocol/server-filesystem 的 entry 脚本绝对路径。
 *  dev 模式在 app/node_modules;打包后在 resources/app.asar.unpacked/node_modules。 */
function locateBundledFilesystemEntry(): string | null {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const norm = here.replace(/^\/([a-zA-Z]:)/, '$1');
  return findPkgEntry(norm, '@modelcontextprotocol/server-filesystem', 'dist/index.js');
}

/** 从当前目录向上找 node_modules/<pkg>/<sub>,返回绝对路径或 null。
 *  Electron 打包后 dist-electron 的 node_modules 可能在上一级,所以要递归往上。 */
function findPkgEntry(startDir: string, pkg: string, sub: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'node_modules', pkg, sub);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('node:fs') as typeof import('node:fs');
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 单例 */
export const mcpManager = new McpManager();
