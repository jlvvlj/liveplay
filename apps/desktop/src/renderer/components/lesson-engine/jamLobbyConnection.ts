import type { JamAbletonSong, JamClientMessage, JamDawSongSummary, JamInviteTarget, JamRoomSummary, JamServerMessage } from './jamRoomProtocol';
import { jamPlayerIdentity } from './jamPlayer';

// An invite this app's player got
export type JamInvite = Extract<JamServerMessage, { t: 'invited' }>;

// The jam app's connection to the room server: the Jam rooms and the Daw
// songs as they change, checks of private room codes, new Daw songs, and
// invites, sent and taken (its inbox is open the whole time). A
// dropped connection is opened again, waiting longer after each failure.

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 10000;

export class JamLobbyConnection {
  private socket: WebSocket | null = null;
  private retryMs = RETRY_FIRST_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private checks = new Map<number, (ok: boolean | null) => void>();
  private made = new Map<number, (id: string | null) => void>();
  private invites = new Map<number, (reached: string[] | null) => void>();
  private nextCheck = 1;
  private closed = false;

  constructor(
    private url: string,
    // The rooms as they change; null when the connection is lost (the last
    // rooms heard stay true until it is back)
    private onRooms: (rooms: JamRoomSummary[] | null) => void,
    private onSongs: (songs: JamDawSongSummary[]) => void,
    private onInvite: (invite: JamInvite) => void
  ) {
    this.connect();
  }

  // Whether `code` opens the private room listed as `id`; null when the
  // server could not be asked
  check(id: string, code: string): Promise<boolean | null> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const c = this.nextCheck++;
    return new Promise((resolve) => {
      this.checks.set(c, resolve);
      this.send({ t: 'check', id, code, c });
    });
  }

  // A new Daw song (see JamClientMessage newSong): its id; null when it could not be made
  newSong(title: string, from: string | null, bpm: number): Promise<string | null> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const c = this.nextCheck++;
    return new Promise((resolve) => {
      this.made.set(c, resolve);
      this.send({ t: 'newSong', c, title, from, bpm });
    });
  }

  // A Daw song imported from an Ableton project, its audio already sent: its id; null when it could not be made
  importSong(title: string, bpm: number, ableton: JamAbletonSong): Promise<string | null> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const c = this.nextCheck++;
    return new Promise((resolve) => {
      this.made.set(c, resolve);
      this.send({ t: 'importSong', c, title, bpm, ableton });
    });
  }

  // Invites players (by lasting id) there, from `name`: those whose app was
  // open to take it; null when the server could not be asked
  invite(to: string[], at: JamInviteTarget, name: string): Promise<string[] | null> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const c = this.nextCheck++;
    return new Promise((resolve) => {
      this.invites.set(c, resolve);
      this.send({ t: 'invite', c, to, at, name });
    });
  }

  offer(song: string, offered: boolean): void {
    this.send({ t: 'offer', song, offered });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.close();
  }

  private connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.retryMs = RETRY_FIRST_MS;
      this.send({ t: 'lobby' });
      jamPlayerIdentity().then(({ key }) => this.send({ t: 'inbox', key }));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as JamServerMessage;
      if (message.t === 'rooms') this.onRooms(message.rooms);
      else if (message.t === 'songs') this.onSongs(message.songs);
      else if (message.t === 'songMade') {
        this.made.get(message.c)?.(message.id);
        this.made.delete(message.c);
      }
      else if (message.t === 'invited') this.onInvite(message);
      else if (message.t === 'inviteSent') {
        this.invites.get(message.c)?.(message.reached);
        this.invites.delete(message.c);
      }
      else if (message.t === 'checked') {
        this.checks.get(message.c)?.(message.ok);
        this.checks.delete(message.c);
      }
    };
    socket.onclose = () => {
      if (this.closed) return;
      this.onRooms(null);
      // Checks waiting on the lost connection can no longer be answered
      for (const resolve of [...this.checks.values(), ...this.made.values(), ...this.invites.values()]) resolve(null);
      this.checks.clear();
      this.made.clear();
      this.invites.clear();
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
  }

  private send(message: JamClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
