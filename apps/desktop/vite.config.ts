import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// Custom plugin to serve files from project directories
function serveProjectFilesPlugin() {
  const projectRoot = path.resolve(__dirname, '../..');
  const audioDir = path.join(projectRoot, 'audio');
  const piecesDir = path.join(projectRoot, 'pieces');

  return {
    name: 'serve-project-files',
    configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: { statusCode?: number; setHeader: (name: string, value: string | number) => void; end: (data?: Buffer | string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        // Handle /audio/ requests
        if (req.url?.startsWith('/audio/')) {
          // Strip query strings (used for cache-busting re-sliced sound clips)
          let filename = req.url.split('?')[0].replace('/audio/', '');
          try {
            filename = decodeURIComponent(filename);
            if (filename.includes('%')) {
              filename = decodeURIComponent(filename);
            }
          } catch {
            // Ignore decode errors
          }
          const filePath = path.join(audioDir, filename);

          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.wav': 'audio/wav',
              '.mp3': 'audio/mpeg',
              '.ogg': 'audio/ogg',
              '.m4a': 'audio/mp4',
              '.aac': 'audio/aac',
            };

            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=31536000');

            const readStream = fs.createReadStream(filePath);
            readStream.pipe(res as unknown as NodeJS.WritableStream);
            return;
          } else {
            res.statusCode = 404;
            res.end('Audio file not found');
            return;
          }
        }

        // Handle /pieces/ requests (MIDI files)
        if (req.url?.startsWith('/pieces/')) {
          let filename = req.url.replace('/pieces/', '');
          try {
            filename = decodeURIComponent(filename);
            if (filename.includes('%')) {
              filename = decodeURIComponent(filename);
            }
          } catch {
            // Ignore decode errors
          }
          const filePath = path.join(piecesDir, filename);

          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.mid': 'audio/midi',
              '.midi': 'audio/midi',
              '.json': 'application/json',
            };

            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Access-Control-Allow-Origin', '*');

            const readStream = fs.createReadStream(filePath);
            readStream.pipe(res as unknown as NodeJS.WritableStream);
            return;
          } else {
            res.statusCode = 404;
            res.end('File not found');
            return;
          }
        }

        // Handle /api/pieces - list available MIDI files
        if (req.url === '/api/pieces') {
          const midiDir = path.join(piecesDir, 'midi');
          if (fs.existsSync(midiDir)) {
            const files = fs.readdirSync(midiDir)
              .filter(f => f.endsWith('.mid') || f.endsWith('.midi'))
              .map(f => ({
                filename: f,
                name: f.replace(/\.midi?$/i, '').replace(/[-_]/g, ' '),
              }));
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(JSON.stringify(files));
            return;
          } else {
            res.setHeader('Content-Type', 'application/json');
            res.end('[]');
            return;
          }
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveProjectFilesPlugin()],
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../../dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Songs API is served by the local Node server (server/index.ts)
      '/api/songs': 'http://localhost:3001',
      '/api/instruments': 'http://localhost:3001',
      '/instrument-lab': 'http://localhost:3001',
    },
    // Allow serving files from outside root directory
    fs: {
      allow: [
        // Allow serving audio files from project root
        path.resolve(__dirname, '../..'),
      ],
    },
  },
});
