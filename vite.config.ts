import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

function verbatimCharacterAssetsPlugin(): Plugin {
  const srcDir = path.resolve(import.meta.dirname, 'assets/Image');
  const distDir = path.resolve(import.meta.dirname, 'dist/assets/Image');
  return {
    name: 'arcane-verbatim-character-assets',
    configureServer(server) {
      server.middlewares.use('/assets/Image', (req, res, next) => {
        const cleanName = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/+/, ''));
        if (!cleanName || cleanName.includes('..') || cleanName.includes('/')) return next();
        const filePath = path.join(srcDir, cleanName);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next();
        const ext = path.extname(cleanName).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'application/octet-stream');
        res.setHeader('Content-Type', mime);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        fs.createReadStream(filePath).pipe(res);
      });
    },
    writeBundle() {
      if (!fs.existsSync(srcDir)) return;
      fs.mkdirSync(distDir, {recursive: true});
      const files = fs.readdirSync(srcDir).filter(f => f.toLowerCase().endsWith('.png'));
      for (const file of files) {
        fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file));
      }
    },
  };
}

export default defineConfig(() => {
  return {
    base: './',
    plugins: [react(), tailwindcss(), verbatimCharacterAssetsPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
