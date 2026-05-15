/**
 * memory-store — 用户级长期记忆。
 *
 * 存储位置:`app.getPath('userData')/memory.json`
 *  - Windows: `C:\Users\<USERNAME>\AppData\Roaming\<appName>\memory.json`
 *  - macOS:   `~/Library/Application Support/<appName>/memory.json`
 *  - Linux:   `~/.config/<appName>/memory.json`
 *
 * 跨模型、跨会话:每次 streamChat 都会把这里的内容注入到 system prompt 里,
 * 这样 AI 在任何会话、用任何模型,都能"记得"用户告诉过它的事。
 *
 * AI 通过两个 builtin tool 操作记忆:
 *  - `app__remember`(content)            → 写入新条目
 *  - `app__forget`(id 或 content_match)  → 删除指定条目
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export interface Memory {
  id: string;
  content: string;
  /** Unix ms */
  createdAt: number;
}

function memoryPath(): string {
  return path.join(app.getPath('userData'), 'memory.json');
}

function genId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

function load(): Memory[] {
  try {
    const raw = fs.readFileSync(memoryPath(), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is Memory =>
        x &&
        typeof x.id === 'string' &&
        typeof x.content === 'string' &&
        typeof x.createdAt === 'number',
    );
  } catch {
    // 文件不存在 / 损坏 → 当成空列表
    return [];
  }
}

function save(list: Memory[]): void {
  const p = memoryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8');
}

/** 列出所有记忆,按创建时间正序(老的在前) */
export function listMemories(): Memory[] {
  return load().sort((a, b) => a.createdAt - b.createdAt);
}

/** 添加一条记忆。返回新条目。
 *  内部会去重 — 已经有完全相同 content 的条目则不重复添加,只把时间刷新一下。 */
export function addMemory(content: string): Memory {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('memory content is empty');
  const list = load();
  const dup = list.find((m) => m.content === trimmed);
  if (dup) {
    dup.createdAt = Date.now();
    save(list);
    return dup;
  }
  const m: Memory = { id: genId(), content: trimmed, createdAt: Date.now() };
  list.push(m);
  save(list);
  return m;
}

/** 按 id 编辑记忆内容。新内容空白会抛错。存在 id 则更新返回 true,否则 false。
 *  不更新 createdAt(保留历史顺序)。 */
export function updateMemory(id: string, content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('memory content is empty');
  const list = load();
  const target = list.find((m) => m.id === id);
  if (!target) return false;
  target.content = trimmed;
  save(list);
  return true;
}

/** 按 id 或内容片段删除。返回删除的数量。
 *  match 可以是完整 id,或者 content 包含的子串(大小写敏感)。 */
export function removeMemory(match: string): number {
  if (!match) return 0;
  const list = load();
  const before = list.length;
  const next = list.filter(
    (m) => m.id !== match && !m.content.includes(match),
  );
  if (next.length === before) return 0;
  save(next);
  return before - next.length;
}

/** 清空所有记忆 — 保留接口给「设置」面板调用。 */
export function clearMemories(): void {
  save([]);
}

/** 拼成给 LLM 看的纯文本块。给 system prompt 用。
 *  空记忆时返回空字符串,调用方可据此判断要不要插入到 prompt。 */
export function formatMemoriesForPrompt(): string {
  const list = listMemories();
  if (list.length === 0) return '';
  const lines = list.map((m) => {
    const d = new Date(m.createdAt);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `  - [${dateStr}] ${m.content}`;
  });
  return [
    '【你关于该用户的长期记忆 — 任何会话、任何模型都会看到】',
    '记忆是用户在过去对话里明确告诉你「记住」的事(偏好 / 习惯 / 个人信息 / 重要事件等)。',
    '回答时如有相关条目,自然地带入参考(不必每次主动提及"我记得你...")。',
    '条目:',
    ...lines,
  ].join('\n');
}
