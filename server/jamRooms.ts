import type { Server } from 'http';
import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import {
  JAM_ROOM_CODE,
  JAM_ROOM_MAX_PLAYERS,
  JAM_ROOM_PATH,
  type JamClientMessage,
  type JamRoomPeer,
  type JamRoomState,
  type JamRoomSummary,
  type JamRoomVisibility,
  type JamServerMessage,
  JAM_ROOM_NAME_MAX,
} from '../apps/desktop/src/renderer/components/lesson-engine/jamRoomProtocol';

// Jam rooms: players who join the same room key play one jam together. The
// server keeps each room's jam (song, when it started or where it paused, the
// grid's edited tracks), answers clock pings so every player shares its clock,
// introduces players to each other so they connect directly, and relays their
// notes too, so a note takes whichever way arrives first. The lobby lists the
// rooms as they change: an open room with its key, a private one without.

// One color per seat, in joining order
const PEER_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185', '#2dd4bf', '#f97316'];
// Lobby lists go out at most this often while rooms change
const LOBBY_MS = 250;

// A player's chosen name, or a numbered one by seat
const playerName = (name: string, seat: number): string =>
  name.trim().slice(0, JAM_ROOM_NAME_MAX) || `Player ${seat + 1}`;

interface Member {
  socket: WebSocket;
  peer: JamRoomPeer;
}

interface Room {
  // Listed in the lobby by `id`; joined by `key` (an open room's id, a private room's code)
  id: string;
  key: string;
  visibility: JamRoomVisibility;
  state: JamRoomState;
  members: Map<string, Member>;
}

export function createJamRooms() {
  const rooms = new Map<string, Room>();
  const lobby = new Set<WebSocket>();
  let lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  const wss = new WebSocketServer({ noServer: true });

  const send = (socket: WebSocket, message: JamServerMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (room: Room, message: JamServerMessage, except?: string) => {
    for (const [id, member] of room.members) if (id !== except) send(member.socket, message);
  };

  const summaries = (): JamRoomSummary[] =>
    [...rooms.values()].map((room) => ({
      id: room.id,
      visibility: room.visibility,
      key: room.visibility === 'open' ? room.key : null,
      songId: room.state.songId,
      playing: room.state.startAt !== null,
      players: [...room.members.values()].map(({ peer }) => ({ name: peer.name, color: peer.color })),
      full: room.members.size >= JAM_ROOM_MAX_PLAYERS,
    }));
  // The lobby hears of a change shortly after, once for a burst of changes
  const lobbyChanged = () => {
    if (lobbyTimer || lobby.size === 0) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      const message: JamServerMessage = { t: 'rooms', rooms: summaries() };
      for (const socket of lobby) send(socket, message);
    }, LOBBY_MS);
  };

  wss.on('connection', (socket) => {
    let room: Room | null = null;
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

      if (message.t === 'lobby') {
        lobby.add(socket);
        send(socket, { t: 'rooms', rooms: summaries() });
        return;
      }

      if (message.t === 'check') {
        const target = rooms.get(message.code);
        send(socket, { t: 'checked', c: message.c, ok: target?.id === message.id });
        return;
      }

      if (message.t === 'join') {
        if (room || !JAM_ROOM_CODE.test(message.room)) {
          socket.close(1008, 'Bad join');
          return;
        }
        let joining = rooms.get(message.room);
        if (!joining && !message.create) {
          send(socket, { t: 'missing' });
          socket.close(1000, 'No such room');
          return;
        }
        if (!joining) {
          const visibility = message.create!;
          joining = {
            id: visibility === 'open' ? message.room : randomBytes(6).toString('hex'),
            key: message.room,
            visibility,
            state: message.state,
            members: new Map(),
          };
        }
        if (joining.members.size >= JAM_ROOM_MAX_PLAYERS) {
          send(socket, { t: 'full' });
          socket.close(1000, 'Room full');
          return;
        }
        room = joining;
        rooms.set(room.key, room);
        const taken = new Set([...room.members.values()].map((member) => member.peer.color));
        const seat = Math.max(0, PEER_COLORS.findIndex((candidate) => !taken.has(candidate)));
        const peer: JamRoomPeer = {
          id,
          name: playerName(message.name, seat),
          color: PEER_COLORS[seat],
          sound: message.sound,
          need: message.need,
          row: null,
        };
        send(socket, {
          t: 'welcome',
          id,
          visibility: room.visibility,
          state: room.state,
          peers: [peer, ...[...room.members.values()].map((member) => member.peer)],
        });
        broadcast(room, { t: 'joined', peer });
        room.members.set(id, { socket, peer });
        lobbyChanged();
        return;
      }

      if (!room) return;
      switch (message.t) {
        case 'state':
          if (message.state.songId !== room.state.songId || (message.state.startAt === null) !== (room.state.startAt === null)) {
            lobbyChanged();
          }
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
          const name = playerName(message.name, PEER_COLORS.indexOf(member.peer.color));
          if (name !== member.peer.name) lobbyChanged();
          member.peer = { ...member.peer, name, sound: message.sound, need: message.need };
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
        case 'cursor': {
          const member = room.members.get(id);
          if (member) member.peer = { ...member.peer, row: message.row };
          broadcast(room, { t: 'cursor', from: id, seq: message.seq, row: message.row }, id);
          break;
        }
        case 'probe': {
          const target = room.members.get(message.to);
          if (target) send(target.socket, { t: 'probe', from: id, c: message.c, back: message.back });
          break;
        }
      }
    });

    socket.on('close', () => {
      lobby.delete(socket);
      if (!room) return;
      room.members.delete(id);
      if (room.members.size === 0) rooms.delete(room.key);
      else broadcast(room, { t: 'left', id });
      lobbyChanged();
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
      if (lobbyTimer) clearTimeout(lobbyTimer);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
