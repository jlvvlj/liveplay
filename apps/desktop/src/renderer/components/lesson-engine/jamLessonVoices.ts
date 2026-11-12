import * as Tone from 'tone';
import { renderJamPartSound } from './jamAudition';
import { JAM_BACKING_TOP_DB, jamLimiter } from './jamBackingMixer';
import { jamAddedInstrument, type JamAddedPart } from './jamAddedParts';
import type { JamLessonLane } from './jamLessonRooms';
import { InstrumentChannel } from './instruments/channel';
import type { InstrumentChoice, InstrumentDef } from './instruments/types';

// A lesson room's hits, everyone's, played with each lesson track's own
// sound: its live instrument when it has one (each lane on the track's own pad
// or pitch), else each lane's part on its pitch, rendered once when the room's
// lesson is known.

// Parts render unscaled. A hit plays at its track's loudness and the backing
// track's full level, as its part plays in the backing, and this much above
// it: at the default Notes volume (75%) a hit stands about 5 dB over its own
// part, at 100% 8 dB
export const JAM_LESSON_HIT_LIFT_DB = 8;

// The hits' level, for a track whose loudness gain is `scale` (the backing
// mixer's), before each hit's velocity and volume
export const jamLessonHitsDb = (scale: number): number => 20 * Math.log10(scale) + JAM_BACKING_TOP_DB + JAM_LESSON_HIT_LIFT_DB;
// A live instrument's hit is let go this long after it starts
const LIVE_HOLD_S = 0.3;

// A lesson track's live instrument, and its lanes
export interface JamLessonLive {
  instrument: InstrumentDef;
  choice: InstrumentChoice;
  bpm: number;
  // The note each of the track's lanes plays on the instrument, by lane note
  notes: Map<number, number>;
}

export class JamLessonVoices {
  // Silent until the track's loudness is known (setScale)
  private readonly output = new Tone.Volume(-Infinity);
  private readonly limiter = jamLimiter();
  private buffers = new Map<number, Tone.ToneAudioBuffer>();
  // Each live lane's instrument channel and the note it plays there
  private liveLanes = new Map<number, { channel: InstrumentChannel; note: number }>();
  private channels: InstrumentChannel[] = [];
  private loaded = false;
  readonly ready: Promise<void>;

  constructor(trackFile: string, lanes: JamLessonLane[], added: JamAddedPart[], ownParts: number, live: JamLessonLive[]) {
    this.limiter.output.toDestination();
    this.output.connect(this.limiter.input);
    const setting = live.map((track) => {
      const channel = new InstrumentChannel(this.output);
      this.channels.push(channel);
      track.notes.forEach((note, lane) => this.liveLanes.set(lane, { channel, note }));
      return channel.set(track.instrument, track.choice, track.bpm);
    });
    const rendering = lanes
      .filter((lane) => !this.liveLanes.has(lane.note))
      .map(async (lane) => {
        const addedPart = lane.part >= ownParts ? added[lane.part - ownParts] : undefined;
        const instrument = addedPart ? jamAddedInstrument(addedPart) : undefined;
        const buffer = await renderJamPartSound(trackFile, lane.part, lane.pitch, instrument ?? undefined);
        this.buffers.set(lane.note, buffer);
      });
    this.ready = Promise.all([...setting, ...rendering]).then(() => undefined);
    this.ready.then(() => {
      this.loaded = true;
    });
  }

  // The track's loudness gain, as the backing mixer has it
  setScale(scale: number) {
    this.output.volume.value = jamLessonHitsDb(scale);
  }

  // A lane's sound at `time` (audio time), at `velocity` and `volume` (0-1);
  // false while its sound is still being prepared
  play(note: number, time: number, velocity: number, volume: number): boolean {
    const live = this.liveLanes.get(note);
    if (live) {
      if (!this.loaded) return false;
      const scaled = Math.max(1, Math.round(velocity * volume));
      live.channel.noteOn(live.note, scaled, time);
      live.channel.noteOff(live.note, time + LIVE_HOLD_S);
      return true;
    }
    const buffer = this.buffers.get(note);
    if (!buffer) return false;
    // Each lane's sound is rendered at velocity 100
    const gain = new Tone.Gain((velocity / 100) * volume).connect(this.output);
    const player = new Tone.Player(buffer).connect(gain);
    player.onstop = () => {
      player.dispose();
      gain.dispose();
    };
    player.start(time);
    return true;
  }

  dispose() {
    this.channels.forEach((channel) => channel.dispose());
    this.output.dispose();
    this.limiter.dispose();
    this.buffers.clear();
  }
}
