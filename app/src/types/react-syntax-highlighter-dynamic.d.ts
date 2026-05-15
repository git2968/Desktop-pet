declare module 'react-syntax-highlighter/dist/esm/prism-light' {
  import type { ComponentType } from 'react';

  const PrismLight: ComponentType<any> & {
    registerLanguage?: (name: string, grammar: unknown) => void;
  };
  export default PrismLight;
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
  export const oneDark: unknown;
}

declare module 'react-syntax-highlighter/dist/esm/languages/prism/*' {
  const grammar: unknown;
  export default grammar;
}
