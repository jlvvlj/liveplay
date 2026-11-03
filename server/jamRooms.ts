import type { Server } from 'http';
import { performance } from 'perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import {
  JAM_ROOM_CODE,
  JAM_ROOM_MAX_PLAYERS,
  JAM_ROOM_PATH,
  type JamClientMessage,
  type JamRoomPeer,
  type JamRoomState,
  type JamServerMessage,
} from '../apps/desktop/src/renderer/components/lesson-engine/jamRoomProtocol';

// Jam rooms: players who join the same room code play one jam together. The
// server keeps each room's jam (song, when it started or where it paused, the
// grid's edited tracks), answers clock pings so every player shares its clock,
// introduces players to each other so they connect directly, and relays their
// notes too, so a note takes whichever way arrives first.

// One color per seat, in joining order
const PEER_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185', '#2dd4bf', '#f97316'];

interface Member {
  socket: WebSocket;
  peer: JamRoomPeer;
}

interface Room {
  state: JamRoomState;
  members: Map<string, Member>;
}

export function createJamRooms() {
  const rooms = new Map<string, Room>();
  let nextId = 1;
  const wss = new WebSocketServer({ noServer: true });

  const send = (socket: WebSocket, message: JamServerMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (room: Room, message: JamServerMessage, except?: string) => {
    for (const [id, member] of room.members) if (id !== except) send(member.socket, message);
  };

  wss.on('connection', (socket) => {
    let room: Room | null = null;
    let code: string | null = null;
    const id = String(nextId++);

    socket.on('message', (raw) => {
      let message: JamClientMessage;
      try {
        message = JSON.parse(String(raw));
      } catch {
        socket.close(1003, 'Not JSON');
        return;
      }

      if (message.t === 'ping') {
        send(socket, { t: 'pong', c: message.c, s: performance.now() });
        return;
      }

      if (message.t === 'join') {
        if (room || !JAM_ROOM_CODE.test(message.room)) {
          socket.close(1008, 'Bad join');
          return;
        }
        code = message.room;
        room = rooms.get(code) ?? { state: message.state, members: new Map() };
        if (room.members.size >= JAM_ROOM_MAX_PLAYERS) {
          send(socket, { t: 'full' });
          room = null;
          socket.close(1000, 'Room full');
          return;
        }
        rooms.set(code, room);
        const taken = new Set([...room.members.values()].map((member) => member.peer.color));
        const color = PEER_COLORS.find((candidate) => !taken.has(candidate)) ?? PEER_COLORS[0];
        const peer: JamRoomPeer = { id, color, sound: message.sound, need: message.need };
        send(socket, {
          t: 'welcome',
          id,
          state: room.state,
          peers: [peer, ...[...room.members.values()].map((member) => member.peer)],
        });
        broadcast(room, { t: 'joined', peer });
        room.members.set(id, { socket, peer });
        return;
      }

      if (!room) return;
      switch (message.t) {
        case 'state':
          room.state = { ...message.state, tracks: room.state.tracks };
          broadcast(room, { t: 'state', state: room.state });
          break;
        case 'track': {
          const tracks = { ...room.state.tracks };
          if (message.edit) tracks[message.file] = message.edit;
          else delete tracks[message.file];
          room.state = { ...room.state, tracks };
          broadcast(room, { t: 'state', state: room.state });
          break;
        }
        case 'peer': {
          const member = room.members.get(id);
          if (!member) break;
          member.peer = { ...member.peer, sound: message.sound, need: message.need };
          broadcast(room, { t: 'peer', peer: member.peer }, id);
          break;
        }
        case 'signal': {
          const target = room.members.get(message.to);
          if (target) send(target.socket, { t: 'signal', from: id, data: message.data });
          break;
        }
        case 'note':
          broadcast(room, { t: 'note', from: id, note: message.note }, id);
          break;
        case 'probe': {
          const target = room.members.get(message.to);
          if (target) send(target.socket, { t: 'probe', from: id, c: message.c, back: message.back });
          break;
        }
      }
    });

    socket.on('close', () => {
      if (!room || !code) return;
      room.members.delete(id);
      if (room.members.size === 0) rooms.delete(code);
      else broadcast(room, { t: 'left', id });
    });
  });

  return {
    // Takes over WebSocket upgrades to the jam room path on `server`
    attach(server: Server) {
      server.on('upgrade', (request, socket, head) => {
        if (request.url?.split('?')[0] !== JAM_ROOM_PATH) return;
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
      });
    },
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
