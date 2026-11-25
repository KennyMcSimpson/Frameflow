import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const DEV_PORT = 5199;

// src/index.html 里写的是发行版的严格 CSP（connect-src 只有 'self' 和 ffmedia:）。
// 开发服务器给它补上热更新地址，打包产物不受影响。
function devCsp() {
  return {
    name: 'frameflow-dev-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx || !ctx.server) return html;
        return html.replace(/(<meta[^>]*Content-Security-Policy[^>]*connect-src [^;"]*)/i, `$1 ws://localhost:${DEV_PORT} http://localhost:${DEV_PORT}`);
      },
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./src', import.meta.url)),
  base: './',
  plugins: [devCsp(), react()],
  build: {
    outDir: fileURLToPath(new URL('./dist-renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // 稳定的公共块：react（框架）、engine（纯函数引擎）、render（合成器/媒体池）
        manualChunks(id) {
          const p = id.replace(/\\/g, '/');
          if (/\/node_modules\/(react|react-dom|scheduler|zustand|use-sync-external-store)\//.test(p)) return 'react';
          if (p.includes('/src/engine/')) return 'engine';
          if (p.includes('/src/render/')) return 'render';
          return undefined;
        },
      },
    },
  },
  server: { port: DEV_PORT, strictPort: true },
});
