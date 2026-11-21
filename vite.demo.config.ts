import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 开发/演示配置：从 examples/basic 启动一个可交互的播放器演示页。
// optimizeDeps.exclude 规避 @yume-chan/libde265 的 WASM 预打包问题（官方建议）。
export default defineConfig({
  root: resolve(__dirname, 'examples/basic'),
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@yume-chan/libde265'],
  },
  server: {
    port: 5188,
    strictPort: false,
  },
  build: {
    outDir: resolve(__dirname, 'dist-demo'),
    emptyOutDir: true,
  },
});
