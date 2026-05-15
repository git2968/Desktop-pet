import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// 主进程 / 预加载 / 渲染进程 三合一打包
// 主进程 → dist-electron/main.js
// 预加载 → dist-electron/preload.js
// 渲染进程 → dist/index.html + assets
export default defineConfig({
  plugins: [
    react(),
    // 给渲染进程提供 Node 内置模块的浏览器版(pixi-live2d-display 内部用了 'url'、'buffer' 等)
    nodePolyfills({
      include: ['url', 'buffer', 'path', 'stream', 'util'],
      globals: { Buffer: true, global: true, process: true },
    }),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // get-windows 是带 prebuilt native binding 的包,必须 external
              // 否则 vite 想 bundle 它的 .node 文件会失败 / 路径错乱
              external: ['electron', 'electron-store', 'get-windows'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              output: {
                // 强制 CommonJS 输出,文件扩展名为 .cjs。
                // 否则 vite-plugin-electron 在 "type":"module" 项目下默认输出 .mjs,
                // 但内容仍是 require() 风格,导致 Electron 的 ESM 加载器报错(require 未定义)。
                format: 'cjs',
                entryFileNames: '[name].cjs',
              },
            },
          },
        },
      },
      // 渲染进程允许 require Node 模块(我们仍走 contextBridge,但留余地)
      renderer: {},
    }),
    renderer(),
  ],
  // 强制 dedupe:pixi.js 自身内部依赖的 @pixi/* 子包,与 lipsyncpatch 直接 import 的 @pixi/* 子包,
  // 必须解析到同一个实例,否则 Container 原型链不一致(isInteractive / null.height 等报错)。
  resolve: {
    dedupe: [
      'pixi.js',
      '@pixi/core',
      '@pixi/display',
      '@pixi/utils',
      '@pixi/math',
      '@pixi/ticker',
      '@pixi/constants',
      '@pixi/settings',
      '@pixi/extensions',
      '@pixi/runner',
      '@pixi/events',
    ],
  },
  optimizeDeps: {
    include: [
      'pixi.js',
      '@pixi/core',
      '@pixi/display',
      'pixi-live2d-display-lipsyncpatch',
      'pixi-live2d-display-lipsyncpatch/cubism4',
    ],
  },
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
