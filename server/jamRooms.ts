import type { Server } from 'http';
import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import {
  JAM_ROOM_CODE,
  JAM_ROOM_MAX_PLAYERS,
  JAM_ROOM_PATH,
  JAM_SONG_TITLE_MAX,
  JAM_ABLETON_FILE,
  type JamAbletonSong,
  type JamClientMessage,
  type JamDawSong,
  type JamDawSongSummary,
  type JamRoomPeer,
  type JamRoomSong,
  type JamRoomState,
  type JamRoomSummary,
  type JamRoomVisibility,
  type JamServerMessage,
  JAM_ROOM_NAME_MAX,
} from '../apps/desktop/src/renderer/components/lesson-engine/jamRoomProtocol';
import { JAM_SONGS, jamRoomSongOf } from '../apps/desktop/src/renderer/components/lesson-engine/jamSongs';
import {
  JAM_DAW_MAX_BPM,
  JAM_DAW_MIN_BPM,
  JAM_SECTION_BARS,
  jamEmptyTrackFile,
  jamTrackByFile,
  jamTrackFileAtTempo,
  jamTrackIsEmpty,
} from '../apps/desktop/src/renderer/components/lesson-engine/jamTracks';
import { validJamTrackEdit, type JamTrackEdit } from '../apps/desktop/src/renderer/components/lesson-engine/jamTrackEdits';
import { jamSongTracks } from '../apps/desktop/src/renderer/components/lesson-engine/jamLessonRooms';
import type { JamSongStore } from './jamSongStore';

// Jam rooms: players who join the same room key play one jam together. The
// server keeps each room's jam (song, when it started or where it paused, the
// grid's edited tracks), answers clock pings so every player shares its clock,
// introduces players to each other so they connect directly, and relays their
// notes too, so a note takes whichever way arrives first. The lobby lists the
// rooms as they change: an open room with its key, a private one without.
// A Jam room plays the song its opener picked, as it was then: a built-in
// song or a Daw song offered to rooms. Daw songs are edited together in
// their own rooms, one per song, and kept in `songs` as they are edited.

// One color per seat, in joining order
const PEER_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185', '#2dd4bf', '#f97316'];
// Lobby lists go out at most this often while rooms change
const LOBBY_MS = 250;
// A room nobody is in stays listed, paused, this long for players to come back to
const EMPTY_ROOM_MS = 30 * 60 * 1000;

// A player's chosen name, or a numbered one by seat
const playerName = (name: string, seat: number): string =>
  name.trim().slice(0, JAM_ROOM_NAME_MAX) || `Player ${seat + 1}`;

interface Member {
  socket: WebSocket;
  peer: JamRoomPeer;
}

interface Room {
  // A Jam room, or the room where a Daw song is edited (`id` and `key` its id)
  kind: 'jam' | 'daw';
  // Listed in the lobby by `id`; joined by `key` (an open room's id, a private room's code)
  id: string;
  key: string;
  visibility: JamRoomVisibility;
  // The player who opened it (their id), by name, and when (in opening order)
  opener: string;
  host: string;
  opened: number;
  state: JamRoomState;
  members: Map<string, Member>;
  // Closes the room while nobody is in it
  closing: ReturnType<typeof setTimeout> | null;
}

// An empty song as it starts, and as it is again when reset: one section, no parts
const EMPTY_SONG_EDIT: JamTrackEdit = { parts: [], bars: JAM_SECTION_BARS };

const dawRoomSong = ({ id, title, bpm, file, transpose }: JamDawSong): JamRoomSong => ({ id, title, bpm, file, transpose });
const songTracks = (song: JamDawSong): Record<string, JamTrackEdit> => (song.edit ? { [song.file]: song.edit } : {});

// An imported song as a client sends it: every track's audio received, and
// its lesson's steps well formed
const IMPORT_MAX_TRACKS = 64;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
function validAbletonSong(value: unknown, audioExists: (id: string) => boolean): value is JamAbletonSong {
  if (!value || typeof value !== 'object') return false;
  const { seconds, tracks } = value as Partial<JamAbletonSong>;
  return (
    finite(seconds) &&
    seconds! > 0 &&
    Array.isArray(tracks) &&
    tracks.length > 0 &&
    tracks.length <= IMPORT_MAX_TRACKS &&
    tracks.every(
      (track) =>
        !!track &&
        typeof track.name === 'string' &&
        typeof track.audio === 'string' &&
        audioExists(track.audio) &&
        !!track.lesson &&
        Array.isArray(track.lesson.steps) &&
        track.lesson.steps.every(
          (step) =>
            !!step &&
            [step.tick, step.note, step.dur, step.velocity].every(finite) &&
            (step.slice === undefined || (finite(step.slice.offset) && finite(step.slice.duration)))
        )
    )
  );
}

// A Daw song's tracks a lesson room can play, by id: an imported song's
// tracks in their order, else its grid's
const songTrackList = (song: Pick<JamDawSong, 'file' | 'edit' | 'ableton'>) =>
  song.ableton
    ? song.ableton.tracks.map((track, index) => ({ id: `ableton-${index}`, name: track.name }))
    : jamSongTracks(song.file, song.edit).map(({ id, name }) => ({ id, name }));

export function createJamRooms({
  songs,
  audioExists = () => false,
  emptyRoomMs = EMPTY_ROOM_MS,
}: {
  songs: JamSongStore;
  // Whether an imported track's audio was received (see jamHttp.ts)
  audioExists?: (id: string) => boolean;
  emptyRoomMs?: number;
}) {
  // Jam rooms by key, Daw songs' rooms by song id
  const rooms = new Map<string, Room>();
  const dawRooms = new Map<string, Room>();
  const lobby = new Set<WebSocket>();
  let lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  let nextRoom = 1;
  const wss = new WebSocketServer({ noServer: true });

  const send = (socket: WebSocket, message: JamServerMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (room: Room, message: JamServerMessage, except?: string) => {
    for (const [id, member] of room.members) if (id !== except) send(member.socket, message);
  };
  const players = (room: Room) => [...room.members.values()].map(({ peer }) => ({ name: peer.name, color: peer.color }));

  // Rooms with players first, then the empty ones; the newest first in each
  const summaries = (): JamRoomSummary[] =>
    [...rooms.values()]
      .sort((a, b) => Number(b.members.size > 0) - Number(a.members.size > 0) || b.opened - a.opened)
      .map((room) => ({
        id: room.id,
        host: room.host,
        visibility: room.visibility,
        key: room.visibility === 'open' ? room.key : null,
        song: room.state.song,
        lesson: room.state.lesson,
        playing: room.state.startAt !== null,
        players: players(room),
        full: room.members.size >= JAM_ROOM_MAX_PLAYERS,
      }));
  const songSummaries = (): JamDawSongSummary[] =>
    songs.list().map(({ edit, ableton, ...song }) => {
      const room = dawRooms.get(song.id);
      return { ...song, editors: room ? players(room) : [], tracks: songTrackList({ file: song.file, edit, ableton }) };
    });
  // The song a new Jam room plays: a built-in one, or a Daw song offered to rooms
  const roomSong = (
    id: string
  ): { song: JamRoomSong; tracks: Record<string, JamTrackEdit>; lessons: { id: string; name: string }[] } | null => {
    const builtIn = JAM_SONGS.find((song) => song.id === id);
    if (builtIn) return { song: jamRoomSongOf(builtIn), tracks: {}, lessons: jamSongTracks(jamRoomSongOf(builtIn).file, null) };
    const daw = songs.get(id);
    return daw?.offered ? { song: dawRoomSong(daw), tracks: songTracks(daw), lessons: songTrackList(daw) } : null;
  };
  // The lobby hears of a change shortly after, once for a burst of changes
  const lobbyChanged = () => {
    if (lobbyTimer || lobby.size === 0) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      const roomList: JamServerMessage = { t: 'rooms', rooms: summaries() };
      const songList: JamServerMessage = { t: 'songs', songs: songSummaries() };
      for (const socket of lobby) {
        send(socket, roomList);
        send(socket, songList);
      }
    }, LOBBY_MS);
  };

  wss.on('connection', (socket) => {
    let room: Room | null = null;
    const id = String(nextId++);

    // Out of the room: the others hear of it; the last one out leaves the
    // room waiting, paused where it was, until it closes
    const leaveRoom = () => {
      if (!room) return;
      const left = room;
      room = null;
      left.members.delete(id);
      // A Daw song is kept as it is edited: its room closes with its last player
      if (left.kind === 'daw' && left.members.size === 0) {
        dawRooms.delete(left.id);
      } else if (left.members.size === 0) {
        const { startAt } = left.state;
        if (startAt !== null) left.state = { ...left.state, startAt: null, position: Math.max(0, (performance.now() - startAt) / 1000) };
        left.closing = setTimeout(() => {
          if (rooms.get(left.key) === left && left.members.size === 0) rooms.delete(left.key);
          lobbyChanged();
        }, emptyRoomMs);
      } else {
        broadcast(left, { t: 'left', id });
      }
      lobbyChanged();
    };

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
        send(socket, { t: 'songs', songs: songSummaries() });
        return;
      }

      if (message.t === 'newSong') {
        const title = String(message.title).trim().slice(0, JAM_SONG_TITLE_MAX);
        const builtIn = message.from === null ? null : JAM_SONGS.find((song) => song.id === message.from);
        const bpm = message.bpm;
        const valid =
          title &&
          (builtIn || (message.from === null && Number.isInteger(bpm) && bpm >= JAM_DAW_MIN_BPM && bpm <= JAM_DAW_MAX_BPM));
        if (!valid) {
          send(socket, { t: 'songMade', c: message.c, id: null });
          return;
        }
        // A copy of a built-in song keeps its 8 bars; an empty one starts with one section
        const made = songs.add(
          builtIn
            ? { ...jamRoomSongOf(builtIn), title, edit: null, offered: false }
            : { title, bpm, file: jamEmptyTrackFile(bpm), transpose: 0, edit: EMPTY_SONG_EDIT, offered: false }
        );
        send(socket, { t: 'songMade', c: message.c, id: made.id });
        lobbyChanged();
        return;
      }

      if (message.t === 'importSong') {
        const title = String(message.title).trim().slice(0, JAM_SONG_TITLE_MAX);
        const { bpm, ableton } = message;
        if (!title || !finite(bpm) || bpm <= 0 || !validAbletonSong(ableton, audioExists)) {
          send(socket, { t: 'songMade', c: message.c, id: null });
          return;
        }
        const made = songs.add({ title, bpm, file: JAM_ABLETON_FILE, transpose: 0, edit: null, offered: false, ableton });
        send(socket, { t: 'songMade', c: message.c, id: made.id });
        lobbyChanged();
        return;
      }

      if (message.t === 'offer') {
        if (!songs.get(message.song)) return;
        songs.update(message.song, { offered: message.offered === true });
        lobbyChanged();
        return;
      }

      if (message.t === 'check') {
        const target = rooms.get(message.code);
        send(socket, { t: 'checked', c: message.c, ok: target?.id === message.id });
        return;
      }

      if (message.t === 'join' || message.t === 'edit') {
        if (room || !JAM_ROOM_CODE.test(message.t === 'join' ? message.room : message.song)) {
          socket.close(1008, 'Bad join');
          return;
        }
        let joining: Room | undefined;
        if (message.t === 'edit') {
          const song = songs.get(message.song);
          if (!song) {
            send(socket, { t: 'missing' });
            socket.close(1000, 'No such song');
            return;
          }
          joining = dawRooms.get(song.id) ?? {
            kind: 'daw',
            id: song.id,
            key: song.id,
            visibility: 'open',
            opener: id,
            host: '',
            opened: nextRoom++,
            state: { song: dawRoomSong(song), lesson: null, startAt: null, position: 0, tracks: songTracks(song) },
            members: new Map(),
            closing: null,
          };
        } else {
          joining = rooms.get(message.room);
          const opening = !joining && message.create ? roomSong(message.create.song) : null;
          // A lesson room's lesson is one of its song's tracks
          const lessonId = message.create?.lesson;
          const lessonTrack = opening && lessonId !== undefined ? opening.lessons.find((track) => track.id === lessonId) : undefined;
          if (!joining && (!opening || (lessonId !== undefined && !lessonTrack))) {
            send(socket, { t: 'missing' });
            socket.close(1000, 'No such room');
            return;
          }
          if (!joining) {
            const visibility = message.create!.visibility === 'private' ? 'private' : 'open';
            joining = {
              kind: 'jam',
              id: visibility === 'open' ? message.room : randomBytes(6).toString('hex'),
              key: message.room,
              visibility,
              opener: id,
              host: '',
              opened: nextRoom++,
              state: {
                song: opening!.song,
                lesson: lessonTrack ? { track: lessonTrack.id, name: lessonTrack.name } : null,
                startAt: null,
                position: 0,
                tracks: opening!.tracks,
              },
              members: new Map(),
              closing: null,
            };
          }
        }
        if (joining.members.size >= JAM_ROOM_MAX_PLAYERS) {
          send(socket, { t: 'full' });
          socket.close(1000, 'Room full');
          return;
        }
        room = joining;
        if (room.kind === 'daw') dawRooms.set(room.id, room);
        else rooms.set(room.key, room);
        if (room.closing) clearTimeout(room.closing);
        room.closing = null;
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
        if (room.opener === id) room.host = peer.name;
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
        case 'leave':
          leaveRoom();
          break;
        case 'state': {
          const { startAt, position } = message.state;
          if ((startAt === null) !== (room.state.startAt === null)) lobbyChanged();
          room.state = { ...room.state, startAt, position };
          broadcast(room, { t: 'state', state: room.state });
          break;
        }
        case 'track': {
          const { file } = room.state.song;
          if (room.kind !== 'daw' || message.file !== file || (message.edit !== null && !validJamTrackEdit(file, message.edit))) break;
          const edit = message.edit ?? (jamTrackIsEmpty(jamTrackByFile(file)!) ? EMPTY_SONG_EDIT : null);
          room.state = { ...room.state, tracks: edit ? { [file]: edit } : {} };
          songs.update(room.id, { edit });
          broadcast(room, { t: 'state', state: room.state });
          break;
        }
        // A Daw song, or a lesson room's song, at another tempo: the same
        // notes on its track at that tempo, carrying on from the same point of
        // the song. A lesson room's tempo is its own: the song it was opened
        // on stays as it was.
        case 'tempo': {
          const { bpm } = message;
          const { song, tracks, startAt, position } = room.state;
          // An imported song plays its recordings at their own tempo
          if ((room.kind !== 'daw' && !room.state.lesson) || song.file === JAM_ABLETON_FILE || !Number.isInteger(bpm) || bpm < JAM_DAW_MIN_BPM || bpm > JAM_DAW_MAX_BPM || bpm === song.bpm) break;
          const file = jamTrackFileAtTempo(song.file, bpm);
          const edit = tracks[song.file];
          const scale = song.bpm / bpm;
          const now = performance.now();
          const at = (startAt === null ? position : (now - startAt) / 1000) * scale;
          room.state = {
            ...room.state,
            song: { ...song, bpm, file },
            startAt: startAt === null ? null : now - at * 1000,
            position: at,
            tracks: edit ? { [file]: edit } : {},
          };
          if (room.kind === 'daw') songs.update(room.id, { bpm, file });
          broadcast(room, { t: 'state', state: room.state });
          lobbyChanged();
          break;
        }
        case 'peer': {
          const member = room.members.get(id);
          if (!member) break;
          const name = playerName(message.name, PEER_COLORS.indexOf(member.peer.color));
          if (name !== member.peer.name) lobbyChanged();
          member.peer = { ...member.peer, name, sound: message.sound, need: message.need };
          if (room.opener === id) room.host = name;
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
      leaveRoom();
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
      songs.flush();
      if (lobbyTimer) clearTimeout(lobbyTimer);
      for (const room of rooms.values()) if (room.closing) clearTimeout(room.closing);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
