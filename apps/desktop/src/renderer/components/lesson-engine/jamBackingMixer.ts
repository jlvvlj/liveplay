import * as Tone from 'tone';
import { renderJamBackingPart, type JamPartAudio } from './jamRenderer';
import { JAM_TRACK_BARS, jamTrackIsEmpty, jamTrackParts, type JamTrack, type JamTrackNote } from './jamTracks';
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

// The Jam tab's backing track at full volume: about 12 dB louder than in
// lessons (x1.3 on +4 dB; its peaks are limited), so the groove stays clearly
// audible under the played notes
export const JAM_BACKING_TOP_DB = 4 + 20 * Math.log10(1.3);

// A level of 0 is silent
const toDb = (level: number) => (level > 0 ? 20 * Math.log10(level) : -Infinity);

// The Jam tab's backing track as one looping player per part, each through its
// own level, then the track's loudness scale and the backing volume. Parts can
// be muted, soloed, levelled and swapped for an edited render while the others
// keep playing.
export class JamBackingMixer implements BackingPlayer {
  // Raised well above the tracks' loudness, so their peaks are held under 0 dBFS
  private readonly limiter = new Tone.Limiter(-1).toDestination();
  private readonly master = new Tone.Volume().connect(this.limiter);
  private readonly trim: Tone.Gain;
  private readonly lanes: { level: Tone.Volume; player: Tone.Player }[];
  // Audio time of the loop's start while playing
  private origin: number | null = null;
  // An imported song's recordings' waveforms, by part
  waveforms: Float32Array[] = [];
  loop = true;
  playbackRate = 1; // The jam always plays at its own tempo
  readonly loaded = true;

  // `scale`: the track's loudness, the gain that brings it to every original
  // track's loudness
  constructor(parts: JamPartAudio[], readonly scale: number, readonly loopSeconds: number) {
    this.trim = new Tone.Gain(scale).connect(this.master);
    this.lanes = parts.map((audio) => {
      const level = new Tone.Volume().connect(this.trim);
      return { level, player: partPlayer(audio).connect(level) };
    });
  }

  get volume() {
    return this.master.volume;
  }

  // Where tracks played by live instruments come in: after the parts' levels,
  // scaled and limited with them
  get input(): Tone.InputNode {
    return this.trim;
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

  // A part added in the grid: a new lane, silent until its audio replaces it
  add(): void {
    const level = new Tone.Volume().connect(this.trim);
    const player = partPlayer(silentJamPart()).connect(level);
    this.lanes.push({ level, player });
    if (this.origin !== null) player.start(Tone.now() + 0.05);
  }

  // A part taken out in the grid; the lanes after it move up
  remove(part: number): void {
    const [lane] = this.lanes.splice(part, 1);
    if (!lane) return;
    lane.player.stop();
    lane.player.dispose();
    lane.level.dispose();
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
    this.limiter.dispose();
  }
}

// A part with nothing to play: a new part, or one a live instrument plays
export const silentJamPart = (): JamPartAudio => ({ channels: [new Float32Array(1)], sampleRate: Tone.getContext().sampleRate });

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

// A mix for `parts` parts: a part added since starts at full level, and the
// entries of parts taken out are dropped
export const fitJamTrackMix = (mix: JamTrackMix, parts: number): JamTrackMix => {
  const fresh = defaultJamTrackMix(parts);
  return {
    levels: fresh.levels.map((level, part) => mix.levels[part] ?? level),
    mutes: fresh.mutes.map((mute, part) => mix.mutes[part] ?? mute),
    solos: fresh.solos.map((solo, part) => mix.solos[part] ?? solo),
  };
};

// What each part plays at: silent when muted, or when others are soloed and it is not
export function jamTrackLevels(mix: JamTrackMix): number[] {
  const soloing = mix.solos.some(Boolean);
  return mix.levels.map((level, part) => (mix.mutes[part] || (soloing && !mix.solos[part]) ? 0 : level));
}

// The original tracks' loudness scales, worked out once per visit
const scales = new Map<string, number>();

// A waveform has at most this many points, however long the recording
const WAVEFORM_POINTS = 1600;

// A recording's loudest moments, one per point, as a share of its loudest
function waveformOf(channels: Float32Array[], frames: number): Float32Array {
  const points = new Float32Array(Math.min(WAVEFORM_POINTS, Math.max(1, frames)));
  const stride = Math.max(1, Math.floor(frames / points.length / 32));
  let top = 0;
  for (let i = 0; i < frames; i += stride) {
    const point = Math.floor((i / frames) * points.length);
    const value = Math.max(Math.abs(channels[0][i]), Math.abs(channels[1][i]));
    if (value > points[point]) points[point] = value;
    if (value > top) top = value;
  }
  return top > 0 ? points.map((value) => value / top) : points;
}

// A recording as a part of a loop of `frames`, cut or filled with silence to
// that length, in stereo
async function loadRecording(url: string, frames: number, sampleRate: number): Promise<JamPartAudio> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  const audio = await new OfflineAudioContext(2, 1, sampleRate).decodeAudioData(await response.arrayBuffer());
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const count = Math.min(frames, audio.length);
  left.set(audio.getChannelData(0).subarray(0, count));
  right.set(audio.getChannelData(audio.numberOfChannels > 1 ? 1 : 0).subarray(0, count));
  return { channels: [left, right], sampleRate };
}

// An imported song's mixer: its recordings, one at a time so memory only ever
// grows by one being decoded, then the parts added in the grid (live
// instruments play those). Scaled to the same loudness as every other track.
async function loadRecordedMixer(track: JamTrack, partCount: number, bars: number): Promise<JamBackingMixer> {
  const recorded = track.recorded!;
  const sampleRate = Tone.getContext().sampleRate;
  const seconds = jamLoopSeconds(track, bars);
  const frames = Math.round(seconds * sampleRate);
  const songFrames = Math.min(frames, Math.round(jamLoopSeconds(track, track.bars) * sampleRate));
  const parts: JamPartAudio[] = [];
  for (const { url } of recorded) parts.push(await loadRecording(url, frames, sampleRate));
  const key = recorded.map(({ url }) => url).join();
  if (!scales.has(key)) {
    const scale = jamLoopScale(parts.map((audio) => audio.channels));
    scales.set(key, Number.isFinite(scale) ? scale : 1);
  }
  const waveforms = parts.map((audio) => waveformOf(audio.channels as Float32Array[], songFrames));
  while (parts.length < partCount) parts.push(silentJamPart());
  const mixer = new JamBackingMixer(parts, scales.get(key)!, seconds);
  mixer.waveforms = waveforms;
  return mixer;
}

// Renders every part of a track (its own, then the ones `added` in the grid)
// as a loop of `bars` bars and returns them in a mixer, scaled by the
// original track's loudness (its 8 bars as they were are rendered too, once,
// for that). Parts `live` instruments play are left silent here.
export async function loadJamBackingMixer(
  track: JamTrack,
  notes: JamTrackNote[][],
  live: boolean[],
  bars = JAM_TRACK_BARS
): Promise<JamBackingMixer> {
  if (track.recorded) return loadRecordedMixer(track, notes.length, bars);
  const parts = await Promise.all(
    notes.map((part, p) => (live[p] ? Promise.resolve(silentJamPart()) : renderJamBackingPart(track.file, p, part, undefined, bars)))
  );
  // An empty track has no loudness of its own to match: its added parts play unscaled
  if (jamTrackIsEmpty(track)) return new JamBackingMixer(parts, 1, jamLoopSeconds(track, bars));
  if (!scales.has(track.file)) {
    const original = jamTrackParts(track).map((part) => part.notes);
    const originals = await Promise.all(
      original.map((part, p) =>
        bars === JAM_TRACK_BARS && !live[p] && JSON.stringify(part) === JSON.stringify(notes[p])
          ? parts[p]
          : renderJamBackingPart(track.file, p, part)
      )
    );
    scales.set(track.file, jamLoopScale(originals.map((audio) => audio.channels)));
  }
  return new JamBackingMixer(parts, scales.get(track.file)!, jamLoopSeconds(track, bars));
}
