import http from 'http';
import { createJamRooms } from './jamRooms';

// The jam room server on its own (npm run start:jam-rooms), for a built jam
// app: point the app at it with VITE_JAM_ROOM_URL (ws://host:port/jam-room).
// npm run dev:jam serves the rooms itself.
const port = Number(process.env.PORT ?? 5191);
const server = http.createServer((_req, res) => {
  res.statusCode = 404;
  res.end();
});
createJamRooms().attach(server);
server.listen(port, () => console.log(`[jam-rooms] listening on ${port}`));
