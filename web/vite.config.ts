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
      // The app's own files: what its entry (index.html) loads, directly or later; the other pages (setup, privacy,
      // account deletion) are not part of the installed app
      const reachable = new Set<string>();
      const visit = (fileName: string) => {
        const item: any = bundle[fileName];
        // A large library loaded only on demand stays out, and so does what only it loads (the PDF export's
        // html2canvas, canvg and DOMPurify: about 370 kB that its name filter below did not catch)
        if (!item || reachable.has(fileName) || LAZY_CHUNK.test(fileName)) return;
        reachable.add(fileName);
        if (item.type !== 'chunk') return;
        for (const next of [...item.imports, ...item.dynamicImports]) visit(next);
        for (const css of item.viteMetadata?.importedCss || []) reachable.add(css);
        for (const asset of item.viteMetadata?.importedAssets || []) reachable.add(asset);
      };
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type === 'chunk' && item.isEntry && item.name === 'index') visit(fileName);
      }
      // Assets referenced from CSS (fonts) are reachable through the CSS file's own metadata
      for (const [fileName, item] of Object.entries(bundle) as [string, any][]) {
        if (item.type === 'asset' && reachable.has(fileName) && fileName.endsWith('.css')) {
          for (const font of Object.keys(bundle).filter(name => /\.(woff2?|ttf)$/.test(name))) reachable.add(font);
        }
      }
      // assets/config.js is not part of the build: the backend writes it for each instance (its name, features). It is
      // kept offline as before, so an app opened offline right after installing still shows the community's name
      const files = [...reachable, 'index.html', 'assets/config.js', ...publicFiles.filter(file => !file.endsWith('.html'))]
        .filter(file => !file.endsWith('.map') && !file.endsWith('.txt') && file !== 'sw.js')
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

/** The app's main font is preloaded (as before): its hashed file name is only known in the build. */
function preloadFont(): Plugin {
  return {
    name: 'agora-preload-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle || !ctx.filename.endsWith('index.html')) return html;
        const font = Object.keys(ctx.bundle).find(file => /inter-latin-(?!ext)[^/]*\.woff2$/.test(file));
        if (!font) return html;
        return [{ tag: 'link', attrs: { rel: 'preload', href: `/${font}`, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head' }];
      }
    }
  };
}

export default defineConfig({
  plugins: [solid(), tailwindcss(), serviceWorker(), preloadFont()],
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
    // Every file the build writes is named after its content (index-Ch43RHov.js): the backend lets browsers keep what
    // is in this folder for a year without asking again (backend/compression.js assetCacheControl). The files of
    // public/ keep their names and stay outside it, they are asked for again on every load.
    assetsDir: 'assets/build',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // The backend writes config.js for every instance (app name, features): it is loaded as it is, never bundled
      external: ['/assets/config.js'],
      input: {
        index: path.join(root, 'index.html'),
        // The first-time setup and the public pages for the app stores (privacy, deleting an account without the app)
        setup: path.join(root, 'setup.html'),
        privacy: path.join(root, 'privacy.html'),
        'account-deletion': path.join(root, 'account-deletion.html')
      }
    }
  }
});
