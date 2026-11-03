// The jam's clocks: the room server's clock (shared by every player in a
// room), this page's clock (performance.now) and the audio clock, and the 16th
// a note lands on. Every player's grid is anchored to the server clock at the
// speakers, so a note on a given 16th sounds at the same moment everywhere.

// One clock ping to the room server: sent and answered on this page's clock
// (ms), stamped by the server on its clock (ms)
export interface ClockSample {
  sent: number;
  received: number;
  server: number;
}

const CLOCK_SAMPLES = 16;

// The server clock as seen from this page. The ping with the shortest round
// trip has the least room for an uneven route, so its midpoint sets the offset.
export class ServerClock {
  private samples: ClockSample[] = [];
  private best: ClockSample | null = null;

  add(sample: ClockSample): void {
    this.samples = [...this.samples.slice(1 - CLOCK_SAMPLES), sample];
    this.best = this.samples.reduce((best, candidate) =>
      candidate.received - candidate.sent < best.received - best.sent ? candidate : best
    );
  }

  get synced(): boolean {
    return this.best !== null;
  }

  // Server ms minus page ms
  get offset(): number {
    if (!this.best) throw new Error('The server clock has no samples yet');
    return this.best.server - (this.best.sent + this.best.received) / 2;
  }

  // Shortest round trip to the server, in ms
  get roundTrip(): number | null {
    return this.best ? this.best.received - this.best.sent : null;
  }

  now(pageMs = performance.now()): number {
    return pageMs + this.offset;
  }

  toPage(serverMs: number): number {
    return serverMs - this.offset;
  }
}

// The audio clock time (s) of the sample leaving the speakers at `pageMs`.
// Browsers without output timestamps give their output latency instead.
export function audioTimeAt(context: AudioContext, pageMs = performance.now()): number {
  const stamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : null;
  if (stamp?.contextTime && stamp.performanceTime) {
    return stamp.contextTime + (pageMs - stamp.performanceTime) / 1000;
  }
  const latency = context.outputLatency || context.baseLatency || 0;
  return context.currentTime - latency + (pageMs - performance.now()) / 1000;
}

// The 16th a hit lands on, `heardSlot` being where the music was (in 16ths)
// when the player hit: the next point of a grid `grid` 16ths apart, or the one
// just passed when the hit is less than `graceSlots` late. In a room it is
// never sooner than `leadSlots` ahead, the time every other player needs to
// get the note and schedule it, so everyone hears it on the same 16th.
export function hitSlot(heardSlot: number, graceSlots: number, leadSlots: number, grid = 1): number {
  const earliest = leadSlots > 0 ? heardSlot + leadSlots : heardSlot - graceSlots;
  return Math.max(0, Math.ceil(earliest / grid - 1e-9) * grid);
}

// Where a note from another player sounds here, in 16ths: on its own 16th when
// there is still time to schedule it (`earliestSlot` is the soonest this
// device can), else like a late hit: right away when it is less than
// `graceSlots` late, otherwise on the next 16th
export function remoteNoteSlot(slot: number, earliestSlot: number, graceSlots: number): number {
  if (slot >= earliestSlot) return slot;
  if (earliestSlot - slot <= graceSlots) return earliestSlot;
  return Math.ceil(earliestSlot);
}

// The 90th percentile of recent round trips (ms): a peer's typical worst case,
// so a jitter spike now and then does not make every note wait
export function roundTripP90(roundTrips: number[]): number | null {
  if (roundTrips.length === 0) return null;
  const sorted = [...roundTrips].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}
