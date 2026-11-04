import type { JamClientMessage, JamRoomSummary, JamServerMessage } from './jamRoomProtocol';

// The jam lobby's connection to the room server: the rooms list as it
// changes, and checks of private room codes. A dropped connection is opened
// again, waiting longer after each failure.

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 10000;

export class JamLobbyConnection {
  private socket: WebSocket | null = null;
  private retryMs = RETRY_FIRST_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private checks = new Map<number, (ok: boolean | null) => void>();
  private nextCheck = 1;
  private closed = false;

  constructor(
    private url: string,
    // The rooms as they change; null when the connection is lost (the last
    // rooms heard stay true until it is back)
    private onRooms: (rooms: JamRoomSummary[] | null) => void
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
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as JamServerMessage;
      if (message.t === 'rooms') this.onRooms(message.rooms);
      else if (message.t === 'checked') {
        this.checks.get(message.c)?.(message.ok);
        this.checks.delete(message.c);
      }
    };
    socket.onclose = () => {
      if (this.closed) return;
      this.onRooms(null);
      // Checks waiting on the lost connection can no longer be answered
      for (const resolve of this.checks.values()) resolve(null);
      this.checks.clear();
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
  }

  private send(message: JamClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
