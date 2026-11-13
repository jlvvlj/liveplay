import { ServerClock, roundTripP90 } from './jamClock';
import {
  JAM_ROOM_NAME_MAX,
  type JamClientMessage,
  type JamDawPresence,
  type JamDirectMessage,
  type JamRoomNote,
  type JamRoomPeer,
  type JamRoomSound,
  type JamRoomState,
  type JamRoomVisibility,
  type JamServerMessage,
  type JamSignal,
} from './jamRoomProtocol';
import { jamPlayerIdentity } from './jamPlayer';
import type { JamTrackEdit } from './jamTrackEdits';

// A jam room on this page: shares the room server's clock and the room's jam,
// connects directly to every other player (WebRTC data channels that never
// wait for a lost packet), and sends each note both ways, directly and through
// the server; whichever arrives first plays, the other is dropped.

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
// Clock pings: a quick burst on joining, then one a second to follow drift
const CLOCK_BURST = 6;
const CLOCK_BURST_MS = 60;
const PING_MS = 1000;
const ROUND_TRIPS_KEPT = 20;
const SEEN_NOTES_KEPT = 512;
// The ship's position goes out at most this often while it moves
const CURSOR_MS = 40;
// Where a player is in a Daw song goes out at most this often while it changes
const PRESENCE_MS = 50;
// A hit never waits longer than this for the slowest player; notes that reach
// a slower player late are handled there like late hits
export const JAM_ROOM_MAX_LEAD_S = 0.15;

export interface JamRoomPlayer extends JamRoomPeer {
  you: boolean;
  // A direct connection to this player is open
  direct: boolean;
  // One-way time to this player (s), its usual worst case over the faster way
  latency: number | null;
}

// Why a room ended for this player: it was full, it no longer exists, the
// connection to it was lost, or its song's recordings could not be loaded
// `taken`: a lesson room's tracks this player picked went to another player first
export type JamRoomEnd = 'full' | 'missing' | 'lost' | 'song' | 'taken';

export interface JamRoomEvents {
  // `by`: the player whose edit of a Daw song's grid this is
  onState: (state: JamRoomState, by?: string) => void;
  onPlayers: (players: JamRoomPlayer[]) => void;
  onNote: (from: string, note: JamRoomNote) => void;
  onClosed: (reason: JamRoomEnd) => void;
}

interface Link {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  signals: Promise<void>;
  direct: number[];
  relay: number[];
}

export function newJamRoomCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => letters[byte % letters.length]).join('');
}

const pushKept = (list: number[], value: number) => {
  list.push(value);
  if (list.length > ROUND_TRIPS_KEPT) list.shift();
};

export class JamRoom {
  readonly clock = new ServerClock();
  id: string | null = null;
  visibility: JamRoomVisibility | null = null;
  state: JamRoomState | null = null;
  private socket: WebSocket;
  private peers = new Map<string, JamRoomPeer>();
  private links = new Map<string, Link>();
  private seen = new Map<string, { set: Set<number>; order: number[] }>();
  private seq = 0;
  private cursorSeq = 0;
  private cursorSeen = new Map<string, number>();
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorPending: number | null = null;
  private cursorLast: number | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presencePending: JamDawPresence | null = null;
  private timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];
  private closed = false;

  constructor(
    readonly code: string,
    url: string,
    // `edit` joins the room where the Daw song `code` is edited; else the Jam
    // room `code`, opened with `create` when it is new
    join: {
      edit?: boolean;
      create?: { visibility: JamRoomVisibility; song: string; lesson?: string[] };
      // In a lesson room, the tracks this player learns
      tracks?: string[];
      name: string;
      sound: JamRoomSound | null;
      need: number;
    },
    private events: JamRoomEvents
  ) {
    this.socket = new WebSocket(url);
    this.socket.onopen = async () => {
      // The player's lasting id goes with them, for the others to invite them by later
      const { player: lasting } = await jamPlayerIdentity();
      const { edit, create, tracks, ...player } = join;
      this.send(
        edit
          ? { t: 'edit', song: code, ...player, player: lasting }
          : { t: 'join', room: code, ...(create ? { create } : {}), ...(tracks ? { tracks } : {}), ...player, player: lasting }
      );
      for (let i = 0; i < CLOCK_BURST; i++) {
        this.timers.push(setTimeout(() => this.send({ t: 'ping', c: performance.now() }), i * CLOCK_BURST_MS));
      }
      this.timers.push(setInterval(() => this.pingAll(), PING_MS));
    };
    this.socket.onmessage = (event) => this.receive(JSON.parse(event.data) as JamServerMessage);
    this.socket.onclose = () => {
      if (this.closed) return;
      this.shutDown();
      this.events.onClosed('lost');
    };
  }

  // Joined, with the room's jam and the server clock known
  get ready(): boolean {
    return this.id !== null && this.state !== null && this.clock.synced;
  }

  // How long (s) a note must be sent before it sounds for every other player to have it in time
  get lead(): number {
    let lead = 0;
    for (const player of this.players()) {
      if (player.you) continue;
      lead = Math.max(lead, player.latency === null ? JAM_ROOM_MAX_LEAD_S : player.latency + player.need);
    }
    return Math.min(lead, JAM_ROOM_MAX_LEAD_S);
  }

  players(): JamRoomPlayer[] {
    return [...this.peers.values()].map((peer) => {
      const link = this.links.get(peer.id);
      const direct = roundTripP90(link?.direct ?? []);
      const relay = roundTripP90(link?.relay ?? []);
      const best = [direct, relay].filter((trip): trip is number => trip !== null);
      return {
        ...peer,
        you: peer.id === this.id,
        direct: link?.channel?.readyState === 'open',
        latency: best.length ? Math.min(...best) / 2000 : null,
      };
    });
  }

  setState(state: Omit<JamRoomState, 'song' | 'lesson' | 'tracks'>): void {
    this.send({ t: 'state', state });
  }

  setTrack(file: string, edit: JamTrackEdit | null): void {
    this.send({ t: 'track', file, edit });
  }

  setTempo(bpm: number): void {
    this.send({ t: 'tempo', bpm });
  }

  setPeer(name: string, sound: JamRoomSound | null, need: number): void {
    const you = this.id ? this.peers.get(this.id) : undefined;
    // The server sends a new name to the others only; this player's own list keeps it too
    if (you) this.peers.set(you.id, { ...you, name: name.trim().slice(0, JAM_ROOM_NAME_MAX) || you.name, sound, need });
    this.send({ t: 'peer', name, sound, need });
    this.emitPlayers();
  }

  // Where this player's ship is, in rows from the top; sent right away, then
  // at most every CURSOR_MS while it keeps moving
  setCursor(row: number): void {
    this.cursorLast = row;
    this.cursorPending = row;
    if (this.cursorTimer) return;
    const flush = () => {
      this.cursorTimer = null;
      const pending = this.cursorPending;
      if (pending === null) return;
      this.cursorPending = null;
      const seq = ++this.cursorSeq;
      const direct = JSON.stringify({ t: 'cursor', seq, row: pending } satisfies JamDirectMessage);
      for (const link of this.links.values()) {
        if (link.channel?.readyState === 'open') link.channel.send(direct);
      }
      this.send({ t: 'cursor', seq, row: pending });
      this.cursorTimer = setTimeout(flush, CURSOR_MS);
    };
    flush();
  }

  // Where this player is in a Daw song: sent right away, then at most every
  // PRESENCE_MS while it keeps changing
  setPresence(presence: JamDawPresence): void {
    this.presencePending = presence;
    if (this.presenceTimer) return;
    const flush = () => {
      this.presenceTimer = null;
      const pending = this.presencePending;
      if (pending === null) return;
      this.presencePending = null;
      this.send({ t: 'presence', presence: pending });
      this.presenceTimer = setTimeout(flush, PRESENCE_MS);
    };
    flush();
  }

  sendNote(note: Omit<JamRoomNote, 'seq'>): void {
    const full: JamRoomNote = { ...note, seq: ++this.seq };
    const direct = JSON.stringify({ t: 'note', note: full } satisfies JamDirectMessage);
    for (const link of this.links.values()) {
      if (link.channel?.readyState === 'open') link.channel.send(direct);
    }
    this.send({ t: 'note', note: full });
  }

  leave(): void {
    if (this.closed) return;
    this.send({ t: 'leave' });
    this.shutDown();
    this.socket.close();
  }

  private shutDown() {
    this.closed = true;
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers = [];
    for (const link of this.links.values()) link.pc.close();
    this.links.clear();
  }

  private send(message: JamClientMessage) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private pingAll() {
    const now = performance.now();
    this.send({ t: 'ping', c: now });
    for (const [id, link] of this.links) {
      if (link.channel?.readyState === 'open') link.channel.send(JSON.stringify({ t: 'ping', c: now } satisfies JamDirectMessage));
      this.send({ t: 'probe', to: id, c: now, back: false });
    }
  }

  private emitPlayers() {
    this.events.onPlayers(this.players());
  }

  private emitStateWhenReady(by?: string) {
    if (this.ready) this.events.onState(this.state!, by);
  }

  private receive(message: JamServerMessage) {
    switch (message.t) {
      case 'welcome':
        this.id = message.id;
        this.visibility = message.visibility;
        this.state = message.state;
        for (const peer of message.peers) {
          this.peers.set(peer.id, peer);
          // The newcomer calls everyone already in the room
          if (peer.id !== message.id) this.link(peer.id, true);
        }
        this.emitPlayers();
        this.emitStateWhenReady();
        // A ship placed before the room answered goes out now
        if (this.cursorLast !== null) this.setCursor(this.cursorLast);
        break;
      case 'full':
      case 'missing':
      case 'taken':
        this.shutDown();
        this.events.onClosed(message.t);
        break;
      case 'pong': {
        const wasReady = this.ready;
        this.clock.add({ sent: message.c, received: performance.now(), server: message.s });
        if (!wasReady) this.emitStateWhenReady();
        break;
      }
      case 'state':
        this.state = message.state;
        this.emitStateWhenReady(message.by);
        break;
      case 'joined':
      case 'peer':
        this.peers.set(message.peer.id, message.peer);
        this.emitPlayers();
        break;
      case 'left':
        this.peers.delete(message.id);
        this.links.get(message.id)?.pc.close();
        this.links.delete(message.id);
        this.seen.delete(message.id);
        this.cursorSeen.delete(message.id);
        this.emitPlayers();
        break;
      case 'signal':
        this.signal(message.from, message.data);
        break;
      case 'note':
        this.deliver(message.from, message.note);
        break;
      case 'cursor':
        this.moveCursor(message.from, message.seq, message.row);
        break;
      case 'presence': {
        const peer = this.peers.get(message.from);
        if (peer) this.peers.set(message.from, { ...peer, presence: message.presence });
        this.emitPlayers();
        break;
      }
      case 'probe':
        if (!message.back) this.send({ t: 'probe', to: message.from, c: message.c, back: true });
        else {
          const link = this.links.get(message.from);
          if (link) pushKept(link.relay, performance.now() - message.c);
          this.emitPlayers();
        }
        break;
    }
  }

  // Each note once, by whichever way it came first
  private deliver(from: string, note: JamRoomNote) {
    let seen = this.seen.get(from);
    if (!seen) this.seen.set(from, (seen = { set: new Set(), order: [] }));
    if (seen.set.has(note.seq)) return;
    seen.set.add(note.seq);
    seen.order.push(note.seq);
    if (seen.order.length > SEEN_NOTES_KEPT) seen.set.delete(seen.order.shift()!);
    this.events.onNote(from, note);
  }

  // A player's ship moved: the latest position wins, whichever way it came
  private moveCursor(from: string, seq: number, row: number) {
    const peer = this.peers.get(from);
    if (!peer || seq <= (this.cursorSeen.get(from) ?? 0)) return;
    this.cursorSeen.set(from, seq);
    this.peers.set(from, { ...peer, row });
    this.emitPlayers();
  }

  private link(id: string, calling: boolean): Link {
    const existing = this.links.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const link: Link = { pc, channel: null, signals: Promise.resolve(), direct: [], relay: [] };
    this.links.set(id, link);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ t: 'signal', to: id, data: { candidate: candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => this.emitPlayers();
    if (calling) {
      this.bindChannel(id, link, pc.createDataChannel('jam', { ordered: false, maxRetransmits: 0 }));
      link.signals = pc
        .setLocalDescription()
        .then(() => this.send({ t: 'signal', to: id, data: { sdp: pc.localDescription!.toJSON() } }))
        .catch((err) => console.error('[JamRoom] Could not call player', id, err));
    } else {
      pc.ondatachannel = ({ channel }) => this.bindChannel(id, link, channel);
    }
    return link;
  }

  // Set-up messages for one connection are applied in the order they came
  private signal(from: string, data: JamSignal) {
    const link = this.link(from, false);
    link.signals = link.signals
      .then(async () => {
        if ('sdp' in data) {
          await link.pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            await link.pc.setLocalDescription();
            this.send({ t: 'signal', to: from, data: { sdp: link.pc.localDescription!.toJSON() } });
          }
        } else {
          await link.pc.addIceCandidate(data.candidate);
        }
      })
      .catch((err) => console.error('[JamRoom] Could not connect to player', from, err));
  }

  private bindChannel(id: string, link: Link, channel: RTCDataChannel) {
    link.channel = channel;
    channel.onopen = () => this.emitPlayers();
    channel.onclose = () => this.emitPlayers();
    channel.onmessage = (event) => {
      const message = JSON.parse(event.data) as JamDirectMessage;
      if (message.t === 'note') this.deliver(id, message.note);
      else if (message.t === 'cursor') this.moveCursor(id, message.seq, message.row);
      else if (message.t === 'ping') channel.send(JSON.stringify({ t: 'pong', c: message.c } satisfies JamDirectMessage));
      else {
        pushKept(link.direct, performance.now() - message.c);
        this.emitPlayers();
      }
    };
  }
}
