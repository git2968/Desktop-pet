import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MarkdownRenderer } from './markdown-renderer';

interface CodeProps {
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

const LARGE_THRESHOLD = 8;

type SyntaxHighlighterComponent = ComponentType<{
  language?: string;
  style?: unknown;
  PreTag?: string;
  customStyle?: CSSProperties;
  wrapLongLines?: boolean;
  showLineNumbers?: boolean;
  children?: ReactNode;
}> & {
  registerLanguage?: (name: string, grammar: unknown) => void;
};

type SyntaxHighlighterBundle = {
  SyntaxHighlighter: SyntaxHighlighterComponent;
  oneDark: unknown;
};

let syntaxHighlighterBasePromise: Promise<SyntaxHighlighterBundle> | null = null;
const loadedSyntaxLanguages = new Set<string>();

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  md: 'markdown',
};

const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
  c: () => import('react-syntax-highlighter/dist/esm/languages/prism/c'),
  cpp: () => import('react-syntax-highlighter/dist/esm/languages/prism/cpp'),
  csharp: () => import('react-syntax-highlighter/dist/esm/languages/prism/csharp'),
  css: () => import('react-syntax-highlighter/dist/esm/languages/prism/css'),
  diff: () => import('react-syntax-highlighter/dist/esm/languages/prism/diff'),
  go: () => import('react-syntax-highlighter/dist/esm/languages/prism/go'),
  java: () => import('react-syntax-highlighter/dist/esm/languages/prism/java'),
  javascript: () => import('react-syntax-highlighter/dist/esm/languages/prism/javascript'),
  json: () => import('react-syntax-highlighter/dist/esm/languages/prism/json'),
  jsx: () => import('react-syntax-highlighter/dist/esm/languages/prism/jsx'),
  markdown: () => import('react-syntax-highlighter/dist/esm/languages/prism/markdown'),
  markup: () => import('react-syntax-highlighter/dist/esm/languages/prism/markup'),
  php: () => import('react-syntax-highlighter/dist/esm/languages/prism/php'),
  powershell: () => import('react-syntax-highlighter/dist/esm/languages/prism/powershell'),
  python: () => import('react-syntax-highlighter/dist/esm/languages/prism/python'),
  ruby: () => import('react-syntax-highlighter/dist/esm/languages/prism/ruby'),
  rust: () => import('react-syntax-highlighter/dist/esm/languages/prism/rust'),
  sql: () => import('react-syntax-highlighter/dist/esm/languages/prism/sql'),
  tsx: () => import('react-syntax-highlighter/dist/esm/languages/prism/tsx'),
  typescript: () => import('react-syntax-highlighter/dist/esm/languages/prism/typescript'),
  yaml: () => import('react-syntax-highlighter/dist/esm/languages/prism/yaml'),
};

function loadSyntaxHighlighterBase(): Promise<SyntaxHighlighterBundle> {
  if (!syntaxHighlighterBasePromise) {
    syntaxHighlighterBasePromise = Promise.all([
      import('react-syntax-highlighter/dist/esm/prism-light'),
      import('react-syntax-highlighter/dist/esm/styles/prism'),
    ]).then(([mod, styles]) => ({
      SyntaxHighlighter: mod.default as unknown as SyntaxHighlighterComponent,
      oneDark: styles.oneDark,
    }));
  }
  return syntaxHighlighterBasePromise;
}

async function loadSyntaxHighlighter(lang: string): Promise<SyntaxHighlighterBundle> {
  const bundle = await loadSyntaxHighlighterBase();
  const requested = lang || 'text';
  const canonical = LANGUAGE_ALIASES[requested] ?? requested;
  const loader = LANGUAGE_LOADERS[canonical];
  if (loader && !loadedSyntaxLanguages.has(requested)) {
    const grammar = (await loader()).default;
    bundle.SyntaxHighlighter.registerLanguage?.(canonical, grammar);
    if (requested !== canonical) {
      bundle.SyntaxHighlighter.registerLanguage?.(requested, grammar);
    }
    loadedSyntaxLanguages.add(canonical);
    loadedSyntaxLanguages.add(requested);
  }
  return bundle;
}

const MermaidBlockLazy = lazy(async () => {
  const mod = await import('./mermaid-block');
  return { default: mod.MermaidBlock };
});

function SyntaxFallback({ code }: { code: string }): JSX.Element {
  return (
    <pre
      style={{
        margin: 0,
        padding: '8px 10px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <code>{code}</code>
    </pre>
  );
}

function SyntaxBlock({
  code,
  lang,
  wrap,
  showLineNumbers,
  large,
}: {
  code: string;
  lang: string;
  wrap: boolean;
  showLineNumbers?: boolean;
  large?: boolean;
}): JSX.Element {
  const [bundle, setBundle] = useState<SyntaxHighlighterBundle | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSyntaxHighlighter(lang).then((loaded) => {
      if (!cancelled) setBundle(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  if (!bundle) return <SyntaxFallback code={code} />;

  const Highlighter = bundle.SyntaxHighlighter;
  return (
    <Highlighter
      language={lang || 'text'}
      style={bundle.oneDark}
      PreTag="div"
      customStyle={{
        margin: 0,
        padding: large ? '12px 16px' : '8px 10px',
        background: 'transparent',
        fontSize: large ? 13 : 12,
      }}
      wrapLongLines={wrap}
      showLineNumbers={showLineNumbers}
    >
      {code}
    </Highlighter>
  );
}

export function CodeBlock(props: CodeProps): JSX.Element {
  const { inline, className, children } = props;
  const [copied, setCopied] = useState(false);
  const [showLarge, setShowLarge] = useState(false);
  const [previewMd, setPreviewMd] = useState(false);

  const raw = String(children ?? '').replace(/\n$/, '');
  const lang = (className?.match(/language-(\w+)/)?.[1] ?? '').toLowerCase();
  if (inline || !lang) {
    return <code className={className}>{children}</code>;
  }

  if (lang === 'mermaid') {
    return (
      <Suspense fallback={<SyntaxFallback code={raw} />}>
        <MermaidBlockLazy code={raw} />
      </Suspense>
    );
  }

  const lineCount = raw.split('\n').length;
  const isMarkdown = lang === 'markdown' || lang === 'md';

  const copy = () => {
    let ok = false;
    if (window.petAPI?.writeClipboard) {
      ok = window.petAPI.writeClipboard(raw);
    }
    if (!ok) {
      void navigator.clipboard?.writeText(raw).catch(() => {});
      ok = true;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="codeblock">
      <div className="codeblock-toolbar">
        <span className="codeblock-lang">{lang || 'text'}</span>
        <span className="codeblock-spacer" />
        {isMarkdown && (
          <button
            type="button"
            className="codeblock-btn"
            onClick={() => setPreviewMd((v) => !v)}
            title={previewMd ? '切回原文' : '渲染 Markdown 预览'}
          >
            {previewMd ? '◧ 原文' : '◨ 预览'}
          </button>
        )}
        {lineCount > LARGE_THRESHOLD && (
          <button
            type="button"
            className="codeblock-btn"
            onClick={() => setShowLarge(true)}
            title={`代码 ${lineCount} 行,在浮窗中查看`}
          >
            ⛶ 大视图
          </button>
        )}
        <button type="button" className="codeblock-btn" onClick={() => void copy()}>
          {copied ? '✓ 已复制' : '⧉ 复制'}
        </button>
      </div>
      <div className="codeblock-body">
        {isMarkdown && previewMd ? (
          <div className="codeblock-md-preview md-body">
            <MarkdownRenderer>{raw}</MarkdownRenderer>
          </div>
        ) : (
          <SyntaxBlock code={raw} lang={lang} wrap={false} />
        )}
      </div>
      {showLarge &&
        createPortal(
          <CodeLargeView code={raw} lang={lang} onClose={() => setShowLarge(false)} />,
          document.body,
        )}
    </div>
  );
}

function CodeLargeView({
  code,
  lang,
  onClose,
}: {
  code: string;
  lang: string;
  onClose: () => void;
}): JSX.Element {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewMd, setPreviewMd] = useState(false);
  const isMarkdown = lang === 'markdown' || lang === 'md';

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('pet:passthrough-suppress', { detail: { suppress: true } }),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.dispatchEvent(
        new CustomEvent('pet:passthrough-suppress', { detail: { suppress: false } }),
      );
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const copy = () => {
    let ok = false;
    if (window.petAPI?.writeClipboard) {
      ok = window.petAPI.writeClipboard(code);
    }
    if (!ok) {
      void navigator.clipboard?.writeText(code).catch(() => {});
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="qa-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="codeblock-large" onClick={(e) => e.stopPropagation()}>
        <div className="codeblock-toolbar codeblock-toolbar--large">
          <span className="codeblock-lang">{lang || 'text'}</span>
          <span className="codeblock-spacer" />
          {isMarkdown && (
            <button
              type="button"
              className="codeblock-btn"
              onClick={() => setPreviewMd((v) => !v)}
              title={previewMd ? '切回原文' : '渲染 Markdown 预览'}
            >
              {previewMd ? '◧ 原文' : '◨ 预览'}
            </button>
          )}
          {!previewMd && (
            <button
              type="button"
              className="codeblock-btn"
              onClick={() => setWrap((v) => !v)}
              title="切换自动换行"
            >
              {wrap ? '↪ 不换行' : '⤶ 换行'}
            </button>
          )}
          <button type="button" className="codeblock-btn" onClick={() => void copy()}>
            {copied ? '✓ 已复制' : '⧉ 复制'}
          </button>
          <button type="button" className="codeblock-btn" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div className="codeblock-large-body">
          {isMarkdown && previewMd ? (
            <div className="codeblock-md-preview md-body">
              <MarkdownRenderer>{code}</MarkdownRenderer>
            </div>
          ) : (
            <SyntaxBlock
              code={code}
              lang={lang}
              wrap={wrap}
              showLineNumbers
              large
            />
          )}
        </div>
      </div>
    </div>
  );
}
