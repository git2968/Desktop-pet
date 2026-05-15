import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkAlert } from 'remark-github-blockquote-alert';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import 'katex/dist/katex.min.css';
import 'remark-github-blockquote-alert/alert.css';
import { CodeBlock } from './code-block';

interface Props {
  children: string;
}

const MD_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkAlert];
const MD_REHYPE_PLUGINS = [rehypeKatex, rehypeRaw];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MdPre = ({ children }: any) => <>{children}</>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MdPlain = ({ children }: any) => <>{children}</>;

const MD_COMPONENTS = {
  code: CodeBlock,
  pre: MdPre,
  del: MdPlain,
  s: MdPlain,
  strike: MdPlain,
};

export function MarkdownRendererHeavy({ children }: Props): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={MD_REMARK_PLUGINS}
      rehypePlugins={MD_REHYPE_PLUGINS}
      components={MD_COMPONENTS}
    >
      {children}
    </ReactMarkdown>
  );
}
