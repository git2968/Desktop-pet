/**
 * MermaidBlock — 把 ```mermaid 代码块渲染成 SVG 图。
 * 用 mermaid.render(id, code) 异步生成 SVG 字符串,塞到 <div> 里。
 * 失败(语法错)时降级显示原始代码。
 */
import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

let initialized = false;
function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'dark',
    fontFamily: 'inherit',
  });
}

/** 修常见的中文向 LLM 输出错误:
 *  - 全角逗号 `,` 当连字符用(`,>` 代替 `->`)— 模型在长输出里偶发把 `-` 替换成 `,`
 *  - 全角破折号 `—` `–` 替换为半角 `-`
 *  - 中文竖线 `|` 替换为半角 `|`(label 周围用)
 *  小心:不动节点 label `[...]` / `{...}` / `"..."` 内部内容(里面的逗号是合法字符)。
 *  做法:逐字符扫描,在 label 块外才做替换。 */
function sanitizeMermaid(input: string): string {
  // 主扫描结果 — 第二步会再 replace 一次,所以是 let
  let out = '';
  let depth = 0; // 在 [...] {...} (...) 内 +1
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuote) {
      if (c === '"') inQuote = false;
      out += c;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      out += c;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') {
      depth++;
      out += c;
      continue;
    }
    if (c === ']' || c === '}' || c === ')') {
      if (depth > 0) depth--;
      out += c;
      continue;
    }
    if (depth > 0) {
      // label 内,原样保留
      out += c;
      continue;
    }
    // 在 label 外做替换
    // 全角破折号 → 半角
    if (c === '—' || c === '–' || c === 'ー') {
      out += '-';
      continue;
    }
    // 全角竖线 \uFF5C → 半角 |(同样要显式 unicode escape)
    if (c === '\uFF5C') {
      out += '|';
      continue;
    }
    // 全角逗号(U+FF0C \uFF0C):模型把 `-` 输出成中文逗号,根据箭头形态恢复正确长度。
    // ⚠ 必须用 \uFF0C 显式区分,否则编辑器会把"全角逗号"替换成半角导致判断失效。
    if (c === ',' || c === '\uFF0C') {
      // 回溯 out 末尾的连续 `-`(防止 `--,>>` 被当成 `-` + `->>` = 3 dash)
      let backDash = 0;
      while (backDash < out.length && out[out.length - 1 - backDash] === '-') {
        backDash++;
      }
      // 向前吃掉连续的半角 `,` 全角 `\uFF0C` 半角 `-`,统计总长
      let j = i;
      let runLen = 0;
      while (input[j] === ',' || input[j] === '\uFF0C' || input[j] === '-') {
        runLen++;
        j++;
      }
      // 把回溯的 dash 从 out 截掉,合并到 totalLen 一起重排
      if (backDash > 0) out = out.slice(0, -backDash);
      const totalLen = backDash + runLen;
      const after = input[j];
      const after2 = input[j + 1];
      // mermaid 只识别 1~2 dash 的箭头(`->`、`-->`、`->>`、`-->>`),3+ dash 不识别
      const cap = (n: number, min: number) => Math.min(Math.max(n, min), 2);
      if (after === '>') {
        if (after2 === '>') {
          // sequenceDiagram 风格:`->>` (实线) 或 `-->>` (虚线)
          out += '-'.repeat(cap(totalLen, 1)) + '>>';
          i = j + 1;
        } else {
          // graph 风格:`-->`(默认,2 dash);`->` (sequence) 也允许
          out += '-'.repeat(cap(totalLen, 2)) + '>';
          i = j;
        }
        continue;
      }
      if (after === '|') {
        // graph `-->|label|`:连字符段 + |,总 dash 至少 2
        out += '-'.repeat(cap(totalLen, 2));
        i = j - 1;
        continue;
      }
      // 单纯的 `,` 不接 > 或 | → 当普通 dash 段
      out += '-'.repeat(totalLen);
      i = j - 1;
      continue;
    }
    out += c;
  }
  // 后处理:节点 label `[xxx]` / `{xxx}` 内若含 emoji,直接移除 emoji。
  // 原因:mermaid v11 对含 BMP emoji(如 ✨ U+2728)的 label tokenize 不稳,
  // 即使加双引号 `["..."]` 也会让后续节点连接报 'got NODE_STRING'(已实测)。
  // 渲染成功优先于保留 emoji 视觉效果 — 中文 label 本身已经够说明问题。
  const stripEmoji = (open: string, close: string) =>
    new RegExp(`(\\${open})([^\\${close}\n]+)(\\${close})`, 'g');
  // /\p{Extended_Pictographic}/gu 覆盖 BMP emoji + supplementary 区,加 \uFE0F 变体选择子
  const emojiGRe = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
  const cleanLabel = (label: string) =>
    label
      .replace(emojiGRe, '')
      .replace(/\s+/g, ' ')
      .trim();
  out = out
    .replace(stripEmoji('[', ']'), (m, o, label: string, c2) => {
      const cleaned = cleanLabel(label);
      return cleaned !== label.trim() ? `${o}${cleaned || 'node'}${c2}` : m;
    })
    .replace(stripEmoji('{', '}'), (m, o, label: string, c2) => {
      const cleaned = cleanLabel(label);
      return cleaned !== label.trim() ? `${o}${cleaned || 'node'}${c2}` : m;
    });
  return out;
}

interface Props {
  code: string;
}

export function MermaidBlock({ code }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ensureInit();
    let cancelled = false;
    // ⚠ 流式渲染期间 code prop 每帧都变,直接渲染会出现 promise race:
    // 前一帧的 reject 落在后一帧的 resolve 之后,把 error 状态盖掉成功状态。
    // debounce 120ms — 等流式停下再实际渲染最终态。
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      // 中文标点修正 + 强制末尾换行(mermaid v11 jison parser 要求)
      const sanitized = sanitizeMermaid(code).replace(/^\s+/, '').replace(/\s*$/, '\n');
      if (!sanitized.trim()) return;
      // 每次新 id,避开 mermaid 内部对失败 id 的 stale cache
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
      mermaid
        .render(id, sanitized)
        .then(({ svg }) => {
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = svg;
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError((e as Error).message ?? '渲染失败');
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-block mermaid-block--error">
        <div className="mermaid-block-err-title">⚠ Mermaid 渲染失败</div>
        <pre className="mermaid-block-err-msg">{error}</pre>
        <pre className="mermaid-block-source">{code}</pre>
      </div>
    );
  }
  return <div className="mermaid-block" ref={ref} />;
}
