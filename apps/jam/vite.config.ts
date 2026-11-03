import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// The jam app (npm run dev:jam / build:jam): the Jam tab as a standalone static
// site. Its sounds and backing tracks are rendered in the browser; in
// development the project's audio/ folder is served too, for the reference
// sounds on this machine.
const projectRoot = path.resolve(__dirname, '../..');

function serveAudioPlugin() {
  const audioDir = path.join(projectRoot, 'audio');
  const types: Record<string, string> = { '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.json': 'application/json' };
  return {
    name: 'jam-serve-audio',
    configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: { statusCode?: number; setHeader: (name: string, value: string | number) => void; end: (data?: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/audio/')) return next();
        const filePath = path.join(audioDir, decodeURIComponent(req.url.split('?')[0].slice('/audio/'.length)));
        if (!filePath.startsWith(audioDir) || !fs.existsSync(filePath)) {
          res.statusCode = 404;
          res.end('Audio file not found');
          return;
        }
        res.setHeader('Content-Type', types[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Content-Length', fs.statSync(filePath).size);
        fs.createReadStream(filePath).pipe(res as unknown as NodeJS.WritableStream);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveAudioPlugin()],
  root: __dirname,
  base: '/',
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5190,
    fs: { allow: [projectRoot] },
  },
});
