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
    rooms = createJamRooms();
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
    a.send({ t: 'join', room: 'ABCD', state: STATE, sound: { id: 'soft-keys' }, need: 0.03 });
    const welcomeA = await a.next('welcome');
    expect(welcomeA.state).toEqual(STATE);
    expect(welcomeA.peers).toHaveLength(1);

    const b = await player(url);
    b.send({ t: 'join', room: 'ABCD', state: { ...STATE, songId: 'other' }, sound: null, need: 0.02 });
    const welcomeB = await b.next('welcome');
    expect(welcomeB.state.songId).toBe('chip-run-jam');
    expect(welcomeB.peers.map((peer) => peer.id)).toEqual([welcomeB.id, welcomeA.id]);
    expect(welcomeB.peers[0].color).not.toBe(welcomeB.peers[1].color);
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
      p.send({ t: 'join', room: 'FULL', state: STATE, sound: null, need: 0 });
      await p.next('welcome');
      players.push(p);
    }
    const late = await player(url);
    late.send({ t: 'join', room: 'FULL', state: STATE, sound: null, need: 0 });
    await late.next('full');
    players.forEach((p) => p.socket.close());
  });
});
