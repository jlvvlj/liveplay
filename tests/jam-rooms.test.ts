/**
 * @jest-environment node
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { createJamRooms } from '../server/jamRooms';
import type {
  JamClientMessage,
  JamRoomState,
  JamServerMessage,
} from '../apps/desktop/src/renderer/components/lesson-engine/jamRoomProtocol';

const STATE: JamRoomState = { songId: 'chip-run-jam', startAt: null, position: 0, tracks: {} };

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

  beforeEach(async () => {
    server = http.createServer();
    rooms = createJamRooms({ emptyRoomMs: 300 });
    rooms.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/jam-room`;
  });

  afterEach(async () => {
    rooms.close();
    await new Promise((resolve) => server.close(resolve));
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
    a.send({ t: 'join', room: 'ABCD', create: 'private', name: '  Aiko ', state: STATE, sound: { id: 'soft-keys' }, need: 0.03 });
    const welcomeA = await a.next('welcome');
    expect(welcomeA.visibility).toBe('private');
    expect(welcomeA.state).toEqual(STATE);
    expect(welcomeA.peers).toHaveLength(1);
    expect(welcomeA.peers[0].name).toBe('Aiko');
    a.send({ t: 'cursor', seq: 1, row: 7.5 });

    const b = await player(url);
    b.send({ t: 'join', room: 'ABCD', name: '', state: { ...STATE, songId: 'other' }, sound: null, need: 0.02 });
    const welcomeB = await b.next('welcome');
    expect(welcomeB.state.songId).toBe('chip-run-jam');
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

    a.send({ t: 'state', state: { songId: 'chip-run-jam', startAt: 1000, position: 0 } });
    expect((await b.next('state')).state.startAt).toBe(1000);
    expect((await a.next('state')).state.startAt).toBe(1000);

    const edit = { parts: [[]], divisions: [null] };
    a.send({ t: 'track', file: 'chip_run.wav', edit });
    expect((await b.next('state')).state.tracks).toEqual({ 'chip_run.wav': edit });

    b.socket.close();
    expect((await a.next('left')).id).toBe(welcomeB.id);
    a.socket.close();
  });

  it('turns players away from a full room', async () => {
    const players = [];
    for (let i = 0; i < 8; i++) {
      const p = await player(url);
      p.send({ t: 'join', room: 'FULL', create: 'open', name: '', state: STATE, sound: null, need: 0 });
      await p.next('welcome');
      players.push(p);
    }
    const late = await player(url);
    late.send({ t: 'join', room: 'FULL', name: '', state: STATE, sound: null, need: 0 });
    await late.next('full');
    players.forEach((p) => p.socket.close());
  });

  it('reports a room that does not exist instead of opening it', async () => {
    const a = await player(url);
    a.send({ t: 'join', room: 'GONE', name: '', state: STATE, sound: null, need: 0 });
    await a.next('missing');
  });

  it('lists rooms in the lobby as they change, without private codes', async () => {
    const lobby = await player(url);
    lobby.send({ t: 'lobby' });
    expect((await lobby.next('rooms')).rooms).toEqual([]);

    const a = await player(url);
    a.send({ t: 'join', room: 'OPEN1', create: 'open', name: 'Aiko', state: STATE, sound: null, need: 0 });
    await a.next('welcome');
    const b = await player(url);
    b.send({ t: 'join', room: 'SECRET', create: 'private', name: 'Ren', state: STATE, sound: null, need: 0 });
    await b.next('welcome');

    let rooms = (await lobby.next('rooms')).rooms;
    if (rooms.length < 2) rooms = (await lobby.next('rooms')).rooms;
    const open = rooms.find((room) => room.visibility === 'open')!;
    const secret = rooms.find((room) => room.visibility === 'private')!;
    expect(open).toMatchObject({ id: 'OPEN1', key: 'OPEN1', songId: 'chip-run-jam', playing: false, full: false });
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
    c.send({ t: 'join', room: open.key!, name: '', state: STATE, sound: null, need: 0 });
    expect((await c.next('welcome')).visibility).toBe('open');

    a.send({ t: 'state', state: { songId: 'softer-jam', startAt: 1000, position: 0 } });
    for (;;) {
      rooms = (await lobby.next('rooms')).rooms;
      if (rooms.find((room) => room.id === 'OPEN1')?.songId === 'softer-jam') break;
    }
    expect(rooms.find((room) => room.id === 'OPEN1')).toMatchObject({ playing: true });
    [a, b, c, lobby].forEach((p) => p.socket.close());
  });

  it('keeps a room nobody is in listed, paused, for a while', async () => {
    const lobby = await player(url);
    lobby.send({ t: 'lobby' });
    await lobby.next('rooms');

    const a = await player(url);
    a.send({ t: 'join', room: 'STAY', create: 'open', name: 'Aiko', state: STATE, sound: null, need: 0 });
    await a.next('welcome');
    a.send({ t: 'state', state: { songId: 'chip-run-jam', startAt: 0, position: 0 } });
    await a.next('state');
    a.socket.close();

    // Left empty: still listed, paused, with nobody in it
    let rooms = (await lobby.next('rooms')).rooms;
    while (rooms[0]?.players.length !== 0) rooms = (await lobby.next('rooms')).rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: 'STAY', playing: false });

    // Coming back finds the jam paused where it was
    const back = await player(url);
    back.send({ t: 'join', room: 'STAY', name: 'Aiko', state: STATE, sound: null, need: 0 });
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
});
