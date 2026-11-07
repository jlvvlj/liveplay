import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { analyzeAudio } from './analyze-audio';
import type { JamSongStore } from './jamSongStore';

// The jam server's HTTP side, for the hosted jam (server/jam-rooms.ts) and the
// development server (apps/jam/vite.config.ts) alike:
//   POST /jam-audio            an imported track's audio (Opus in WebM); its id back
//   GET  /jam-audio/<id>       that audio
//   GET  /jam-songs/<id>       a Daw song as kept, with an imported song's tracks
//   POST /api/songs/analyze-audio?bpm=   hits in an audio track's export, as the
//                              full app's Ableton import asks for them
// Audio is kept by its content's hash next to the songs, in `<songs>/audio`.

const AUDIO_MAX_BYTES = 40 * 1024 * 1024;
const ANALYSIS_MAX_BYTES = 300 * 1024 * 1024;
const AUDIO_ID = /^[0-9a-f]{64}$/;

type Next = (error?: unknown) => void;

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`More than ${Math.round(limit / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

export const jamAudioDir = (songsDir: string) => path.join(songsDir, 'audio');
export const jamAudioExists = (songsDir: string, id: string) =>
  AUDIO_ID.test(id) && fs.existsSync(path.join(jamAudioDir(songsDir), `${id}.webm`));

export function createJamHttp({ songsDir, songs, repoRoot }: { songsDir: string; songs: JamSongStore; repoRoot: string }) {
  const audioDir = jamAudioDir(songsDir);
  fs.mkdirSync(audioDir, { recursive: true });

  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? '/', 'http://jam');
    try {
      if (req.method === 'POST' && url.pathname === '/jam-audio') {
        const body = await readBody(req, AUDIO_MAX_BYTES);
        if (body.length === 0) return sendJson(res, 400, { error: 'No audio received.' });
        const id = createHash('sha256').update(body).digest('hex');
        const file = path.join(audioDir, `${id}.webm`);
        if (!fs.existsSync(file)) {
          fs.writeFileSync(`${file}.tmp`, body);
          fs.renameSync(`${file}.tmp`, file);
        }
        return sendJson(res, 200, { id });
      }
      const audio = /^\/jam-audio\/([0-9a-f]{64})$/.exec(url.pathname);
      if (req.method === 'GET' && audio) {
        const file = path.join(audioDir, `${audio[1]}.webm`);
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'No such audio.' });
        res.setHeader('Content-Type', 'audio/webm');
        res.setHeader('Content-Length', fs.statSync(file).size);
        // Kept by its content's hash: it never changes
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        fs.createReadStream(file).pipe(res);
        return;
      }
      const song = /^\/jam-songs\/([A-Z0-9]{4,8})$/.exec(url.pathname);
      if (req.method === 'GET' && song) {
        const found = songs.get(song[1]);
        return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'No such song.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/songs/analyze-audio') {
        const body = await readBody(req, ANALYSIS_MAX_BYTES);
        if (body.length === 0) return sendJson(res, 400, { error: 'No audio received.' });
        return sendJson(res, 200, await analyzeAudio(repoRoot, body, Number(url.searchParams.get('bpm'))));
      }
      next();
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
