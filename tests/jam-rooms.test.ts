/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { createJamRooms } from '../server/jamRooms';
import { createJamSongStore } from '../server/jamSongStore';
import type {
  JamClientMessage,
  JamRoomState,
  JamServerMessage,
} from '../apps/desktop/src/renderer/components/lesson-engine/jamRoomProtocol';
import { JAM_SONGS, jamRoomSongOf } from '../apps/desktop/src/renderer/components/lesson-engine/jamSongs';

const CHIP = jamRoomSongOf(JAM_SONGS.find((song) => song.id === 'chip-run-jam')!);
const STATE: JamRoomState = { song: CHIP, lesson: null, startAt: null, position: 0, tracks: {} };
const opening = (song = 'chip-run-jam') => ({ visibility: 'open' as const, song });

// A test player: its socket and every message it got
async function player(url: string) {
  const socket = new WebSocket(url);
  const inbox: JamServerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on('message', (raw) => {
    inbox.push(JSON.parse(String(raw)));
    waiters.splice(0).forEach((wake) => wake());
  });
  await new Promise((resolve) => socket.once('open', resolve));
  return {
    socket,
    send: (message: JamClientMessage) => socket.send(JSON.stringify(message)),
    // The first message of type `t` not taken yet
    async next<T extends JamServerMessage['t']>(t: T): Promise<Extract<JamServerMessage, { t: T }>> {
      for (;;) {
        const index = inbox.findIndex((message) => message.t === t);
        if (index >= 0) return inbox.splice(index, 1)[0] as Extract<JamServerMessage, { t: T }>;
        await new Promise<void>((wake) => waiters.push(wake));
      }
    },
  };
}

describe('jam rooms', () => {
  let server: http.Server;
  let rooms: ReturnType<typeof createJamRooms>;
  let url: string;
  let songsDir: string;

  beforeEach(async () => {
    songsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-songs-'));
    server = http.createServer();
    rooms = createJamRooms({ songs: createJamSongStore(songsDir), emptyRoomMs: 300 });
    rooms.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/jam-room`;
  });

  afterEach(async () => {
    rooms.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(songsDir, { recursive: true, force: true });
  });

  it('answers clock pings with its own time', async () => {
    const a = await player(url);
    a.send({ t: 'ping', c: 42 });
    const pong = await a.next('pong');
    expect(pong.c).toBe(42);
    expect(typeof pong.s).toBe('number');
    a.socket.close();
  });

  it('keeps the first player\'s jam, introduces players and relays notes', async () => {
    const a = await player(url);
    a.send({ t: 'join', room: 'ABCD', create: { visibility: 'private', song: 'chip-run-jam' }, name: '  Aiko ', sound: { id: 'soft-keys' }, need: 0.03 });
    const welcomeA = await a.next('welcome');
    expect(welcomeA.visibility).toBe('private');
    expect(welcomeA.state).toEqual(STATE);
    expect(welcomeA.peers).toHaveLength(1);
    expect(welcomeA.peers[0].name).toBe('Aiko');
    a.send({ t: 'cursor', seq: 1, row: 7.5 });

    const b = await player(url);
    b.send({ t: 'join', room: 'ABCD', create: opening('softer-jam'), name: '', sound: null, need: 0.02 });
    const welcomeB = await b.next('welcome');
    expect(welcomeB.state.song).toEqual(CHIP);
    expect(welcomeB.peers.map((peer) => peer.id)).toEqual([welcomeB.id, welcomeA.id]);
    expect(welcomeB.peers[0].color).not.toBe(welcomeB.peers[1].color);
    // A player without a name gets their seat's; a newcomer sees where the others' ships are
    expect(welcomeB.peers[0].name).toBe('Player 2');
    expect(welcomeB.peers[1].row).toBe(7.5);

    b.send({ t: 'cursor', seq: 1, row: 3 });
    expect(await a.next('cursor')).toEqual({ t: 'cursor', from: welcomeB.id, seq: 1, row: 3 });
    b.send({ t: 'peer', name: 'Ren', sound: null, need: 0.02 });
    expect((await a.next('peer')).peer.name).toBe('Ren');
    expect((await a.next('joined')).peer.id).toBe(welcomeB.id);

    b.send({ t: 'note', note: { seq: 1, song: 'chip-run-jam', slot: 12, note: 57 } });
    expect(await a.next('note')).toEqual({ t: 'note', from: welcomeB.id, note: { seq: 1, song: 'chip-run-jam', slot: 12, note: 57 } });

    b.send({ t: 'signal', to: welcomeA.id, data: { candidate: { candidate: 'x' } } });
    expect((await a.next('signal')).from).toBe(welcomeB.id);

    a.send({ t: 'state', state: { startAt: 1000, position: 0 } });
    expect((await b.next('state')).state).toEqual({ ...STATE, startAt: 1000 });
    expect((await a.next('state')).state.startAt).toBe(1000);

    b.socket.close();
    expect((await a.next('left')).id).toBe(welcomeB.id);
    a.socket.close();
  });

  it('turns players away from a full room', async () => {
    const players = [];
    for (let i = 0; i < 8; i++) {
      const p = await player(url);
      p.send({ t: 'join', room: 'FULL', create: opening(), name: '', sound: null, need: 0 });
      await p.next('welcome');
      players.push(p);
    }
    const late = await player(url);
    late.send({ t: 'join', room: 'FULL', name: '', sound: null, need: 0 });
    await late.next('full');
    players.forEach((p) => p.socket.close());
  });

  it('reports a room that does not exist instead of opening it', async () => {
    const a = await player(url);
    a.send({ t: 'join', room: 'GONE', name: '', sound: null, need: 0 });
    await a.next('missing');
  });

  it('lists rooms in the lobby as they change, without private codes', async () => {
    const lobby = await player(url);
    lobby.send({ t: 'lobby' });
    expect((await lobby.next('rooms')).rooms).toEqual([]);

    const a = await player(url);
    a.send({ t: 'join', room: 'OPEN1', create: opening(), name: 'Aiko', sound: null, need: 0 });
    await a.next('welcome');
    const b = await player(url);
    b.send({ t: 'join', room: 'SECRET', create: { visibility: 'private', song: 'chip-run-jam' }, name: 'Ren', sound: null, need: 0 });
    await b.next('welcome');

    let rooms = (await lobby.next('rooms')).rooms;
    if (rooms.length < 2) rooms = (await lobby.next('rooms')).rooms;
    const open = rooms.find((room) => room.visibility === 'open')!;
    const secret = rooms.find((room) => room.visibility === 'private')!;
    expect(open).toMatchObject({ id: 'OPEN1', host: 'Aiko', key: 'OPEN1', song: CHIP, playing: false, full: false });
    expect(secret.host).toBe('Ren');
    // The newest room first
    expect(rooms.map((room) => room.host)).toEqual(['Ren', 'Aiko']);
    expect(open.players).toEqual([{ name: 'Aiko', color: '#38bdf8' }]);
    expect(secret.key).toBeNull();
    expect(secret.id).not.toBe('SECRET');
    expect(JSON.stringify(rooms)).not.toContain('SECRET');

    // A private room's code is checked against its listing
    lobby.send({ t: 'check', id: secret.id, code: 'SECRET', c: 1 });
    expect(await lobby.next('checked')).toEqual({ t: 'checked', c: 1, ok: true });
    lobby.send({ t: 'check', id: secret.id, code: 'OPEN1', c: 2 });
    expect(await lobby.next('checked')).toEqual({ t: 'checked', c: 2, ok: false });

    // An open room is joined by its listed key
    const c = await player(url);
    c.send({ t: 'join', room: open.key!, name: '', sound: null, need: 0 });
    expect((await c.next('welcome')).visibility).toBe('open');

    a.send({ t: 'state', state: { startAt: 1000, position: 0 } });
    for (;;) {
      rooms = (await lobby.next('rooms')).rooms;
      if (rooms.find((room) => room.id === 'OPEN1')?.playing) break;
    }
    [a, b, c, lobby].forEach((p) => p.socket.close());
  });

  it('keeps a room nobody is in listed, paused, for a while', async () => {
    const lobby = await player(url);
    lobby.send({ t: 'lobby' });
    await lobby.next('rooms');

    const a = await player(url);
    a.send({ t: 'join', room: 'STAY', create: opening(), name: 'Aiko', sound: null, need: 0 });
    await a.next('welcome');
    a.send({ t: 'state', state: { startAt: 0, position: 0 } });
    await a.next('state');
    a.socket.close();

    // Left empty: still listed, paused, with nobody in it
    let rooms = (await lobby.next('rooms')).rooms;
    while (rooms[0]?.players.length !== 0) rooms = (await lobby.next('rooms')).rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: 'STAY', playing: false });

    // Coming back finds the jam paused where it was
    const back = await player(url);
    back.send({ t: 'join', room: 'STAY', name: 'Aiko', sound: null, need: 0 });
    const welcome = await back.next('welcome');
    expect(welcome.state.startAt).toBeNull();
    expect(welcome.state.position).toBeGreaterThan(0);

    // Leaving says so: the room is empty again before the connection closes
    back.send({ t: 'leave' });
    rooms = (await lobby.next('rooms')).rooms;
    while (rooms[0]?.players.length !== 0) rooms = (await lobby.next('rooms')).rooms;
    back.socket.close();

    // Empty past its time, the room closes
    for (;;) {
      rooms = (await lobby.next('rooms')).rooms;
      if (rooms.length === 0) break;
    }
    lobby.socket.close();
  });

  it('opens a lesson room on one of its song\'s tracks, and lists it with its lesson', async () => {
    const lobby = await player(url);
    lobby.send({ t: 'lobby' });
    await lobby.next('rooms');
    const a = await player(url);
    a.send({ t: 'join', room: 'LESSON', create: { visibility: 'open', song: 'chip-run-jam', lesson: 'part-3' }, name: 'Aiko', sound: null, need: 0 });
    expect((await a.next('welcome')).state.lesson).toEqual({ track: 'part-3', name: 'Bass' });
    let rooms = (await lobby.next('rooms')).rooms;
    while (!rooms.length) rooms = (await lobby.next('rooms')).rooms;
    expect(rooms[0]).toMatchObject({ id: 'LESSON', lesson: { track: 'part-3', name: 'Bass' } });
    // A track the song does not have opens nothing
    const b = await player(url);
    b.send({ t: 'join', room: 'NOLESSON', create: { visibility: 'open', song: 'chip-run-jam', lesson: 'part-99' }, name: '', sound: null, need: 0 });
    await b.next('missing');
    [a, lobby].forEach((p) => p.socket.close());
  });

  it('opens a room only on a song it can play', async () => {
    const a = await player(url);
    a.send({ t: 'join', room: 'NOPE', create: opening('no-such-song'), name: '', sound: null, need: 0 });
    await a.next('missing');
  });

  it('makes Daw songs, edits them together and keeps every edit', async () => {
    const lobby = await player(url);
    lobby.send({ t: 'lobby' });
    expect((await lobby.next('songs')).songs).toEqual([]);

    lobby.send({ t: 'newSong', c: 1, title: '  Night ', from: null, bpm: 128 });
    const { id } = await lobby.next('songMade');
    expect(id).toMatch(/^[A-Z0-9]{8}$/);
    lobby.send({ t: 'newSong', c: 2, title: 'Copy', from: 'chip-run-jam', bpm: 0 });
    const copy = (await lobby.next('songMade')).id!;
    // Bad input makes nothing
    lobby.send({ t: 'newSong', c: 3, title: 'Fast', from: null, bpm: 900 });
    expect((await lobby.next('songMade')).id).toBeNull();

    let songs = (await lobby.next('songs')).songs;
    while (songs.length < 2) songs = (await lobby.next('songs')).songs;
    // The newest first; a copy of a built-in song plays its track
    expect(songs.map((song) => song.title)).toEqual(['Copy', 'Night']);
    expect(songs[0]).toMatchObject({ id: copy, bpm: CHIP.bpm, file: CHIP.file, transpose: CHIP.transpose, offered: false, editors: [] });
    expect(songs[1]).toMatchObject({ id, bpm: 128, file: 'empty-128.wav', offered: false });

    // Its room: an empty song starts with one 4-bar section and no parts
    const a = await player(url);
    a.send({ t: 'edit', song: id!, name: 'Aiko', sound: null, need: 0 });
    const welcomeA = await a.next('welcome');
    expect(welcomeA.state.song).toEqual({ id, title: 'Night', bpm: 128, file: 'empty-128.wav', transpose: 0 });
    expect(welcomeA.state.tracks).toEqual({ 'empty-128.wav': { parts: [], bars: 4 } });
    const b = await player(url);
    b.send({ t: 'edit', song: id!, name: 'Ren', sound: null, need: 0 });
    await b.next('welcome');
    for (;;) {
      songs = (await lobby.next('songs')).songs;
      if (songs.find((song) => song.id === id)?.editors.length === 2) break;
    }

    // An edit reaches the other editor and is kept; one that does not fit the track is not
    const edit = {
      parts: [[{ pitch: 36, step: 0, length: 1, velocity: 127 }]],
      added: [{ track: 't1', sound: 'square-stab' }],
      bars: 8,
    };
    a.send({ t: 'track', file: 'chip_run.wav', edit });
    a.send({ t: 'track', file: 'empty-128.wav', edit: { parts: [[], []], bars: 4 } });
    a.send({ t: 'track', file: 'empty-128.wav', edit });
    expect((await b.next('state')).state.tracks).toEqual({ 'empty-128.wav': edit });
    await a.next('state');

    // Offered, it can open a Jam room, which plays it as it is
    const room = await player(url);
    room.send({ t: 'join', room: 'DAWJAM', create: opening(id!), name: '', sound: null, need: 0 });
    await room.next('missing');
    lobby.send({ t: 'offer', song: id!, offered: true });
    for (;;) {
      songs = (await lobby.next('songs')).songs;
      if (songs.find((song) => song.id === id)?.offered) break;
    }
    const jam = await player(url);
    jam.send({ t: 'join', room: 'DAWJAM', create: opening(id!), name: '', sound: null, need: 0 });
    const welcome = await jam.next('welcome');
    expect(welcome.state.song.id).toBe(id);
    expect(welcome.state.tracks).toEqual({ 'empty-128.wav': edit });
    // A Jam room's song cannot be edited
    jam.send({ t: 'track', file: 'empty-128.wav', edit: { parts: [], bars: 4 } });

    // A reset empty song is one empty section again
    b.send({ t: 'track', file: 'empty-128.wav', edit: null });
    expect((await a.next('state')).state.tracks).toEqual({ 'empty-128.wav': { parts: [], bars: 4 } });
    b.send({ t: 'track', file: 'empty-128.wav', edit });
    await a.next('state');

    // A new tempo keeps the notes, on the track at that tempo; out of range it is refused
    a.send({ t: 'tempo', bpm: 400 });
    a.send({ t: 'tempo', bpm: 140 });
    for (;;) {
      const { state } = await b.next('state');
      if (state.song.bpm !== 140) continue;
      expect(state.song.file).toBe('empty-140.wav');
      expect(state.tracks).toEqual({ 'empty-140.wav': edit });
      break;
    }

    [a, b, jam, lobby].forEach((p) => p.socket.close());
    rooms.close();
    const kept = createJamSongStore(songsDir);
    expect(kept.get(id!)).toMatchObject({ title: 'Night', offered: true, edit, bpm: 140, file: 'empty-140.wav' });
    expect(kept.get(copy)).toMatchObject({ edit: null });
  });

  it('lists songs made in the same instant newest first', () => {
    const store = createJamSongStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jam-songs-')));
    const song = { title: '', bpm: 120, file: 'empty-120.wav', transpose: 0, edit: null, offered: false };
    const first = store.add({ ...song, title: 'First' });
    const second = store.add({ ...song, title: 'Second' });
    expect(second.created).toBeGreaterThan(first.created);
    expect(store.list().map((made) => made.title)).toEqual(['Second', 'First']);
  });

  it('plays a copy of a built-in song at another tempo, and back at its own', async () => {
    const lobby = await player(url);
    lobby.send({ t: 'newSong', c: 1, title: 'Fast chip', from: 'chip-run-jam', bpm: 0 });
    const id = (await lobby.next('songMade')).id!;
    const a = await player(url);
    a.send({ t: 'edit', song: id, name: '', sound: null, need: 0 });
    await a.next('welcome');
    a.send({ t: 'tempo', bpm: 130 });
    expect((await a.next('state')).state.song).toMatchObject({ bpm: 130, file: `${CHIP.file}@130` });
    a.send({ t: 'tempo', bpm: CHIP.bpm });
    expect((await a.next('state')).state.song).toMatchObject({ bpm: CHIP.bpm, file: CHIP.file });
    [a, lobby].forEach((p) => p.socket.close());
  });
});
