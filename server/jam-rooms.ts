import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import { createJamRooms } from './jamRooms';
import { createJamSongStore } from './jamSongStore';
import { createJamHttp, jamAudioExists } from './jamHttp';

// The jam room server on its own (npm run start:jam-rooms). With
// JAM_STATIC_DIR set (the hosted jam, see fly.toml) it also serves the built
// jam app from that folder, so the app finds its rooms on its own address;
// without it, point a built app at it with VITE_JAM_ROOM_URL
// (ws://host:port/jam-room). npm run dev:jam serves the rooms itself.
// The Daw's songs, and imported songs' audio, are kept in JAM_SONGS_DIR (the
// hosted jam's volume).
const songsDir = process.env.JAM_SONGS_DIR;
if (!songsDir) throw new Error('Set JAM_SONGS_DIR to the folder that keeps the Daw songs');
const port = Number(process.env.PORT ?? 5191);
const app = express();
const songs = createJamSongStore(path.resolve(songsDir));
app.use(createJamHttp({ songsDir: path.resolve(songsDir), songs, repoRoot: path.resolve(__dirname, '..') }));
if (process.env.JAM_STATIC_DIR) {
  const staticDir = path.resolve(process.env.JAM_STATIC_DIR);
  // Big files have a gzipped copy beside them (instrument-ports/catalog.mjs),
  // sent to browsers that take it
  app.use((req, res, next) => {
    const file = path.join(staticDir, decodeURIComponent(req.path));
    if (!file.startsWith(staticDir + path.sep) || !req.acceptsEncodings('gzip') || !fs.existsSync(`${file}.gz`)) return next();
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.type(path.extname(file));
    res.sendFile(`${path.relative(staticDir, file)}.gz`, { root: staticDir });
  });
  app.use(express.static(staticDir));
}
const server = http.createServer(app);
createJamRooms({ songs, audioExists: (id) => jamAudioExists(path.resolve(songsDir), id) }).attach(server);
server.listen(port, () => console.log(`[jam-rooms] listening on ${port}`));
