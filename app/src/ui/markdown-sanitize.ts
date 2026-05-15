/**
 * Markdown 修复 — 在交给 react-markdown 前做最小化的"中文化错误"修补。
 * 当前主要修:GFM 表格分隔行被模型写成 `| , | , : | : , : | : , |`(中文标点代替 `---`)。
 * 不动 mermaid / 代码块内容 — 这些由 ```...``` 围栏识别,跳过即可。
 */

const FENCE_RE = /^```/;

/** 一个单元格如果只含 半角逗号 `,` / 全角逗号 `\uFF0C` / `:` / `-` / 空白,
 *  且至少含 1 个 `, \uFF0C -`,就视为分隔行的 cell。
 *  ⚠ 必须用 `\uFF0C` 显式写中文全角逗号,否则编辑器会替换成半角导致失效。 */
function looksLikeSepCell(cell: string): boolean {
  const t = cell.trim();
  if (!t) return false;
  if (!/^[\s\-,\uFF0C:]*$/.test(t)) return false;
  return /[-,\uFF0C]/.test(t);
}

/** 把单元格里的 `:` 还原成 GFM 对齐: `:---:` / `:---` / `---:` / `---` */
function rebuildSepCell(cell: string): string {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return ':---:';
  if (left) return ':---';
  if (right) return '---:';
  return '---';
}

/** 模型经常把整个表格压成一行,row 之间是 ` | | ` 这种空 cell 边界。
 *  尝试按"空字符串 cell"作为 row 边界拆分。
 *  返回拆好的多行 markdown,失败返回 null。
 *  阈值:整行 `|` 数 ≥ 12 才尝试,避免误伤短的正文。 */
function tryUnflattenTable(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  const pipeCount = (t.match(/\|/g) ?? []).length;
  if (pipeCount < 12) return null;
  const inner = t.slice(1, -1);
  const cells = inner.split('|').map((s) => s.trim());
  // 用空 cell 作为 row 边界
  const rows: string[][] = [];
  let cur: string[] = [];
  for (const c of cells) {
    if (c === '') {
      if (cur.length > 0) {
        rows.push(cur);
        cur = [];
      }
    } else {
      cur.push(c);
    }
  }
  if (cur.length > 0) rows.push(cur);
  if (rows.length < 2) return null;
  // 用最大 row 长度对齐(短的补空)
  const N = Math.max(...rows.map((r) => r.length));
  if (N < 2) return null;
  const out = rows.map((r) => {
    const padded = r.concat(Array(N - r.length).fill(''));
    return '| ' + padded.join(' | ') + ' |';
  });
  // 至少看起来像表(2 行以上)
  return out.length >= 2 ? out : null;
}

/** 把所有 CSP 不允许的 `![alt](src)` 改写为纯链接 `[🖼 alt](src)`。
 *  CSP 白名单:`data:` / `blob:` / `pet:` / 同源(`./` `/`)— 其它一律改写。
 *  包括:http(s)://、模型乱写的 `<URL>`、`example.com/x.png`、`#`、空字符串等。
 *  原因:CSP 拒后 `<img>` 仍按 width/height 占位留下大段空白。源头改写最稳。
 *  ⚠ 不动 fenced code block 内的内容(由调用方判断 inFence 时跳过)。*/
function isLocalImageSrc(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  return /^(?:data:|blob:|pet:|\.{0,2}\/)/.test(s);
}
function rewriteExternalImage(line: string): string {
  return line.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, alt: string, url: string) =>
      isLocalImageSrc(url) ? m : `[🖼 ${alt || '外部图片'}](${url})`,
  );
}

export function sanitizeMarkdown(input: string): string {
  if (!input) return input;

  // 第 0 步:整文一次性剥离 HTML 删除线标签(可能跨多行)。
  //   - <s>...</s> / <del>...</del> / <strike>...</strike>
  //   - 自闭合或残缺的 <s>、</s>
  //   - inline style 里的 text-decoration: line-through(span 残留无样式不影响)
  // 必须在逐行处理前做,因为多行内容用 ^/$ 单行模式抓不到。
  input = input
    .replace(/<\s*(s|del|strike)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '$2')
    .replace(/<\s*\/?\s*(s|del|strike)\b[^>]*\/?>/gi, '')
    .replace(/text-decoration\s*:\s*[^;"']*line-through[^;"']*;?/gi, '');

  let lines = input.split('\n');

  // 第 1 步:把"压成一行的表格"拆成多行
  const unflattened: string[] = [];
  let inFence1 = false;
  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      inFence1 = !inFence1;
      unflattened.push(line);
      continue;
    }
    if (inFence1) {
      unflattened.push(line);
      continue;
    }
    // 外部图片改写成链接,避免 CSP 拦截后 <img> 占位空白
    let lineNoExtImg = rewriteExternalImage(line);
    // 剥离 GFM 删除线 ~~xxx~~ → xxx(只保留文字)。
    // 模型即使 prompt 禁过,roleplay "嘴硬改口" 时还是会用,直接渲染层去掉最稳。
    // 注意:不动 fenced code(由 inFence1 保护),inline code 内的 ~~ 也少见,可接受副作用。
    lineNoExtImg = lineNoExtImg.replace(/~~([^\n~][^\n]*?)~~/g, '$1');
    // 剥离 HTML 删除线标签 — 因为我们用了 rehype-raw,AI 也可能输出 <s>/<del>/<strike>。
    // 同时去掉 inline style 里的 text-decoration: line-through(更隐蔽,但偶尔出现)。
    lineNoExtImg = lineNoExtImg
      .replace(/<\s*(s|del|strike)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '$2')
      .replace(/<\s*(s|del|strike)\b[^>]*\/?>/gi, '') // 自闭合或残缺标签
      .replace(/text-decoration\s*:\s*[^;"']*line-through[^;"']*;?/gi, '');
    const expanded = tryUnflattenTable(lineNoExtImg);
    if (expanded) {
      // 拆分前后留空行,保证 GFM 能识别为表格块
      if (unflattened.length > 0 && unflattened[unflattened.length - 1].trim() !== '') {
        unflattened.push('');
      }
      unflattened.push(...expanded);
      unflattened.push('');
    } else {
      unflattened.push(lineNoExtImg);
    }
  }
  lines = unflattened;

  // 第 2 步:把分隔行的中文化标点(`, , :`)恢复成 `---` / `:---:`
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

    const inner = trimmed.slice(1, -1);
    const cells = inner.split('|').map((s) => s.trim());
    if (cells.length < 1) continue;

    if (!cells.every(looksLikeSepCell)) continue;
    const prev = (lines[i - 1] ?? '').trim();
    if (!prev.startsWith('|') || !prev.endsWith('|')) continue;

    const fixed = cells.map(rebuildSepCell);
    const leading = line.match(/^\s*/)?.[0] ?? '';
    lines[i] = leading + '| ' + fixed.join(' | ') + ' |';
  }
  return lines.join('\n');
}
