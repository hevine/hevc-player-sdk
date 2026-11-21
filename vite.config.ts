import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 库构建：产出框架无关的核心包 + 独立的 React 绑定子路径。
// react / react-dom 作为 peerDependency 外置，核心包不引入任何 UI 框架。
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2022',
    lib: {
      entry: {
        'hevc-player': resolve(__dirname, 'src/index.ts'),
        react: resolve(__dirname, 'src/react/index.ts'),
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) =>
        format === 'es' ? `${entryName}.js` : `${entryName}.cjs`,
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
