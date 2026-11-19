import { defineConfig, type Plugin } from 'vite';
import solid from '@solidjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
// The backend the dev server sends the API to (npm run dev): BACKEND=http://localhost:3000 by default
const backend = process.env.BACKEND || 'http://localhost:3000';

// Large libraries loaded only when a page needs them (PDF viewer, HEIC photos, PDF export) stay out of the offline cache
const LAZY_CHUNK = /(pdf\.worker|pdfjs|pdf-|heic2any|html2pdf)/i;

/** dist/sw.js from sw.template.js: the list of files to keep offline and a cache name that changes with the build. */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'agora-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const publicDir = path.join(root, 'public');
      const publicFiles: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else publicFiles.push(path.relative(publicDir, full).split(path.sep).join('/'));
        }
      };
      if (fs.existsSync(publicDir)) walk(publicDir);
      const files = [...Object.keys(bundle), ...publicFiles]
        .filter(file => !file.endsWith('.map') && !file.endsWith('.txt') && file !== 'sw.js')
        .filter(file => !file.endsWith('.html') || file === 'index.html')
        .filter(file => !LAZY_CHUNK.test(file))
        .sort();
      const list = ['./', ...files.map(file => `./${file}`)];
      const index = fs.readFileSync(path.join(outDir, 'index.html'));
      const version = createHash('sha256').update(list.join('\n')).update(index).digest('hex').slice(0, 12);
      const template = fs.readFileSync(path.join(root, 'sw.template.js'), 'utf8');
      const sw = template
        .replace('__CACHE_VERSION__', version)
        .replace('__PRECACHE_LIST__', JSON.stringify(list, null, 4).replace(/\n\]$/, '\n]'));
      fs.writeFileSync(path.join(outDir, 'sw.js'), sw);
    }
  };
}

export default defineConfig({
  plugins: [solid(), tailwindcss(), serviceWorker()],
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/data': { target: backend, changeOrigin: false },
      // Served by the backend: the instance's name and features, and its logo
      '/assets/config.js': { target: backend, changeOrigin: false },
      '/assets/church-logo.svg': { target: backend, changeOrigin: false }
    }
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // The backend writes config.js for every instance (app name, features): it is loaded as it is, never bundled
      external: ['/assets/config.js'],
      input: {
        index: path.join(root, 'index.html')
      }
    }
  }
});
