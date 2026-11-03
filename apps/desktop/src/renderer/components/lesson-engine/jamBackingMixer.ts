import * as Tone from 'tone';
import { renderJamBackingPart, type JamPartAudio } from './jamRenderer';
import { jamTrackParts, type JamTrack, type JamTrackNote } from './jamTracks';
import { jamLoopScale, jamLoopSeconds } from './jamTrackRender';

// What the lesson player needs from a backing track: a Tone.Player, or the
// Jam tab's mixer
export interface BackingPlayer {
  volume: { value: number };
  playbackRate: number;
  loop: boolean;
  readonly loaded: boolean;
  readonly state: string;
  start(time?: number, offset?: number): unknown;
  stop(time?: number): unknown;
  dispose(): unknown;
}

// A level of 0 is silent
const toDb = (level: number) => (level > 0 ? 20 * Math.log10(level) : -Infinity);

// The Jam tab's backing track as one looping player per part, each through its
// own level, then the track's loudness scale and the backing volume. Parts can
// be muted, soloed, levelled and swapped for an edited render while the others
// keep playing.
export class JamBackingMixer implements BackingPlayer {
  private readonly master = new Tone.Volume().toDestination();
  private readonly trim: Tone.Gain;
  private readonly lanes: { level: Tone.Volume; player: Tone.Player }[];
  // Audio time of the loop's start while playing
  private origin: number | null = null;
  loop = true;
  playbackRate = 1; // The jam always plays at its own tempo
  readonly loaded = true;

  constructor(parts: JamPartAudio[], scale: number, readonly loopSeconds: number) {
    this.trim = new Tone.Gain(scale).connect(this.master);
    this.lanes = parts.map((audio) => {
      const level = new Tone.Volume().connect(this.trim);
      return { level, player: partPlayer(audio).connect(level) };
    });
  }

  get volume() {
    return this.master.volume;
  }

  get state() {
    return this.origin === null ? 'stopped' : 'started';
  }

  start(time = Tone.now(), offset = 0) {
    const at = ((offset % this.loopSeconds) + this.loopSeconds) % this.loopSeconds;
    this.origin = time - at;
    for (const lane of this.lanes) lane.player.start(time, at);
    return this;
  }

  stop(time = Tone.now()) {
    if (this.origin === null) return this;
    for (const lane of this.lanes) lane.player.stop(time);
    this.origin = null;
    return this;
  }

  // Levels per part, 0 to 1 (0 is silent)
  setLevels(levels: number[]) {
    levels.forEach((level, part) => {
      if (this.lanes[part]) this.lanes[part].level.volume.value = toDb(level);
    });
  }

  // An edited part comes in at the same point of the loop
  replace(part: number, audio: JamPartAudio) {
    const lane = this.lanes[part];
    const old = lane.player;
    lane.player = partPlayer(audio).connect(lane.level);
    if (this.origin !== null) {
      const at = Tone.now() + 0.05;
      lane.player.start(at, (((at - this.origin) % this.loopSeconds) + this.loopSeconds) % this.loopSeconds);
      old.stop(at);
    }
    setTimeout(() => old.dispose(), 500);
  }

  dispose() {
    for (const lane of this.lanes) {
      lane.player.dispose();
      lane.level.dispose();
    }
    this.trim.dispose();
    this.master.dispose();
  }
}

function partPlayer(audio: JamPartAudio): Tone.Player {
  const buffer = Tone.getContext().createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate);
  audio.channels.forEach((channel, c) => buffer.getChannelData(c).set(channel));
  const player = new Tone.Player(new Tone.ToneAudioBuffer(buffer));
  player.loop = true;
  return player;
}

// A part's settings in the mixer
export interface JamTrackMix {
  levels: number[]; // 0 to 1
  mutes: boolean[];
  solos: boolean[];
}

export const defaultJamTrackMix = (parts: number): JamTrackMix => ({
  levels: Array(parts).fill(1),
  mutes: Array(parts).fill(false),
  solos: Array(parts).fill(false),
});

// What each part plays at: silent when muted, or when others are soloed and it is not
export function jamTrackLevels(mix: JamTrackMix): number[] {
  const soloing = mix.solos.some(Boolean);
  return mix.levels.map((level, part) => (mix.mutes[part] || (soloing && !mix.solos[part]) ? 0 : level));
}

// The original tracks' loudness scales, worked out once per visit
const scales = new Map<string, number>();

// Renders every part of a track and returns them in a mixer, scaled by the
// original track's loudness (parts the player edited are rendered as they
// were too, once, for that)
export async function loadJamBackingMixer(track: JamTrack, notes: JamTrackNote[][]): Promise<JamBackingMixer> {
  const parts = await Promise.all(notes.map((part, p) => renderJamBackingPart(track.file, p, part)));
  if (!scales.has(track.file)) {
    const original = jamTrackParts(track).map((part) => part.notes);
    const originals = await Promise.all(
      original.map((part, p) =>
        JSON.stringify(part) === JSON.stringify(notes[p]) ? parts[p] : renderJamBackingPart(track.file, p, part)
      )
    );
    scales.set(track.file, jamLoopScale(originals.map((audio) => audio.channels)));
  }
  return new JamBackingMixer(parts, scales.get(track.file)!, jamLoopSeconds(track));
}
