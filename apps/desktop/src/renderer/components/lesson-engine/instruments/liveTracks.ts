import * as Tone from 'tone';
import type { JamTrackNote } from '../jamTracks';
import { InstrumentChannel } from './channel';
import type { InstrumentChoice, InstrumentDef } from './types';
import { PAD_BASE_NOTE } from './types';

// The backing track's tracks that play live instruments (every track added in
// the grid, and the track's own ones given an instrument): each through its
// own channel, its notes sent a little ahead of time as the loop plays.

// The scheduler runs this often and sends what sounds within the horizon (s)
const TICK_MS = 25;
const HORIZON_S = 0.12;
// A loop start moved by more than this (a restart, a seek) begins afresh (s)
const RESTART_S = 0.05;
const SHORTEST_NOTE_S = 0.03;

export interface LiveTrack {
  key: string;
  instrument: InstrumentDef;
  choice: InstrumentChoice;
  // Its parts, by index in the track's notes, and a drum part's pad
  parts: { part: number; pad: number | null }[];
}

// What the scheduler reads as it runs
export interface LiveClock {
  // Audio time of the loop's first 16th as heard, or null while paused
  start: () => number | null;
  sixteenth: () => number;
  loopSteps: () => number;
  // A step as played (swing)
  swing: (step: number) => number;
  notes: () => JamTrackNote[][];
  // Each part's level, 0 for a muted one
  levels: () => number[];
}

// One note to send: its instrument note, velocity, and audio times
export interface LiveEvent {
  note: number;
  velocity: number;
  on: number;
  off: number;
}

// The notes of a track's parts that sound in [from, to), the loop starting
// at `start` and repeating every `loopSteps` 16ths. Each part plays at its
// `level` (0 silent) of the velocity; a drum part on its pad.
export function liveEvents(
  window: { start: number; from: number; to: number },
  timing: { sixteenth: number; loopSteps: number; swing: (step: number) => number },
  parts: { notes: JamTrackNote[]; pad: number | null; level: number }[]
): LiveEvent[] {
  const { start, from, to } = window;
  const { sixteenth, loopSteps, swing } = timing;
  const loopSeconds = loopSteps * sixteenth;
  const firstLoop = Math.floor((from - start) / loopSeconds);
  const lastLoop = Math.floor((to - start) / loopSeconds);
  const events: LiveEvent[] = [];
  for (const { notes, pad, level } of parts) {
    if (level <= 0) continue;
    for (const note of notes) {
      if (note.step >= loopSteps) continue;
      for (let loop = firstLoop; loop <= lastLoop; loop++) {
        const on = start + (loop * loopSteps + swing(note.step)) * sixteenth;
        if (on < from || on >= to) continue;
        events.push({
          note: pad !== null ? PAD_BASE_NOTE + pad : note.pitch,
          velocity: Math.max(1, Math.min(127, Math.round(note.velocity * level))),
          on,
          off: on + Math.max(SHORTEST_NOTE_S, note.length * sixteenth),
        });
      }
    }
  }
  return events;
}

export class JamLiveTracks {
  private tracks: LiveTrack[] = [];
  private channels = new Map<string, InstrumentChannel>();
  private loadedChannels = new Set<string>();
  private until = 0;
  private lastStart: number | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private destination: Tone.InputNode, private readonly clock: LiveClock) {
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  // The tracks as they are now; a track's channel is kept while its key is
  set(tracks: LiveTrack[], bpm: number) {
    this.tracks = tracks;
    for (const [key, channel] of this.channels) {
      if (tracks.some((track) => track.key === key)) continue;
      channel.allOff();
      setTimeout(() => channel.dispose(), 300);
      this.channels.delete(key);
      this.loadedChannels.delete(key);
    }
    for (const track of tracks) {
      let channel = this.channels.get(track.key);
      if (!channel) {
        channel = new InstrumentChannel(this.destination);
        this.channels.set(track.key, channel);
      }
      const ready = channel.set(track.instrument, track.choice, bpm);
      ready.then(
        () => this.loadedChannels.add(track.key),
        (err) => console.error(`[JamLiveTracks] Could not load ${track.instrument.name}:`, err)
      );
    }
  }

  // Sends the tracks into a new mixer
  route(destination: Tone.InputNode) {
    this.destination = destination;
    for (const channel of this.channels.values()) channel.route(destination);
  }

  // One note of a track at once, as the grid's piano keys and drum names play it
  audition(key: string, part: { pitch: number; pad: number | null }) {
    const channel = this.channels.get(key);
    if (!channel) return false;
    const note = part.pad !== null ? PAD_BASE_NOTE + part.pad : part.pitch;
    const now = Tone.getContext().currentTime + 0.01;
    channel.noteOn(note, 100, now);
    channel.noteOff(note, now + 0.4);
    return true;
  }

  private tick() {
    const start = this.clock.start();
    const context = Tone.getContext();
    const now = context.currentTime;
    if (start === null) {
      if (this.lastStart !== null) this.channels.forEach((channel) => channel.allOff());
      this.lastStart = null;
      return;
    }
    if (this.lastStart === null || Math.abs(start - this.lastStart) > RESTART_S) {
      if (this.lastStart !== null) this.channels.forEach((channel) => channel.allOff());
      this.until = now;
    }
    this.lastStart = start;
    const from = Math.max(this.until, now);
    const to = now + HORIZON_S;
    if (to <= from) return;
    this.until = to;

    const timing = { sixteenth: this.clock.sixteenth(), loopSteps: this.clock.loopSteps(), swing: this.clock.swing };
    const notes = this.clock.notes();
    const levels = this.clock.levels();
    for (const track of this.tracks) {
      const channel = this.channels.get(track.key);
      if (!channel || !this.loadedChannels.has(track.key)) continue;
      // The track's loudest part sets its channel; the others play softer
      const top = Math.max(0, ...track.parts.map(({ part }) => levels[part] ?? 1));
      channel.level = top > 0 ? 20 * Math.log10(top) : -Infinity;
      if (top <= 0) continue;
      const parts = track.parts.map(({ part, pad }) => ({ notes: notes[part] ?? [], pad, level: (levels[part] ?? 1) / top }));
      for (const event of liveEvents({ start, from, to }, timing, parts)) {
        channel.noteOn(event.note, event.velocity, event.on);
        channel.noteOff(event.note, event.off);
      }
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.channels.forEach((channel) => channel.dispose());
    this.channels.clear();
  }
}
