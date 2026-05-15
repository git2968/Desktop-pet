import { lazy, Suspense } from 'react';

interface Props {
  children: string;
}

const MarkdownRendererHeavy = lazy(async () => {
  const mod = await import('./markdown-renderer-heavy');
  return { default: mod.MarkdownRendererHeavy };
});

export function MarkdownRenderer({ children }: Props): JSX.Element {
  return (
    <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{children}</span>}>
      <MarkdownRendererHeavy>{children}</MarkdownRendererHeavy>
    </Suspense>
  );
}
