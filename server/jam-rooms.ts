import http from 'http';
import path from 'path';
import express from 'express';
import { createJamRooms } from './jamRooms';
import { createJamSongStore } from './jamSongStore';

// The jam room server on its own (npm run start:jam-rooms). With
// JAM_STATIC_DIR set (the hosted jam, see fly.toml) it also serves the built
// jam app from that folder, so the app finds its rooms on its own address;
// without it, point a built app at it with VITE_JAM_ROOM_URL
// (ws://host:port/jam-room). npm run dev:jam serves the rooms itself.
// The Daw's songs are kept in JAM_SONGS_DIR (the hosted jam's volume).
const songsDir = process.env.JAM_SONGS_DIR;
if (!songsDir) throw new Error('Set JAM_SONGS_DIR to the folder that keeps the Daw songs');
const port = Number(process.env.PORT ?? 5191);
const app = express();
if (process.env.JAM_STATIC_DIR) {
  app.use(express.static(path.resolve(process.env.JAM_STATIC_DIR)));
}
const server = http.createServer(app);
createJamRooms({ songs: createJamSongStore(path.resolve(songsDir)) }).attach(server);
server.listen(port, () => console.log(`[jam-rooms] listening on ${port}`));
