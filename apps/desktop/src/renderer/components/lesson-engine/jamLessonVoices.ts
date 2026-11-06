import * as Tone from 'tone';
import { renderJamPartSound } from './jamAudition';
import { jamAddedInstrument, type JamAddedPart } from './jamAddedParts';
import type { JamLessonLane } from './jamLessonRooms';
import { InstrumentChannel } from './instruments/channel';
import type { InstrumentChoice, InstrumentDef } from './instruments/types';

// A lesson room's hits, everyone's, played with the lesson track's own sound:
// its live instrument when it has one (each lane on the track's own pad or
// pitch), else each lane's part on its pitch, rendered once when the room's
// lesson is known.

// Parts render unscaled: held under 0 dBFS, like the mixer's parts
const LEVEL_DB = -6;
// A live instrument's hit is let go this long after it starts
const LIVE_HOLD_S = 0.3;

export interface JamLessonLive {
  instrument: InstrumentDef;
  choice: InstrumentChoice;
  bpm: number;
  // The note each lane plays on the instrument, by lane note
  notes: Map<number, number>;
}

export class JamLessonVoices {
  private readonly output = new Tone.Volume(LEVEL_DB);
  private readonly limiter = new Tone.Limiter(-1).toDestination();
  private buffers = new Map<number, Tone.ToneAudioBuffer>();
  private channel: InstrumentChannel | null = null;
  private loaded = false;
  readonly ready: Promise<void>;

  constructor(
    trackFile: string,
    lanes: JamLessonLane[],
    added: JamAddedPart[],
    ownParts: number,
    private readonly live: JamLessonLive | null
  ) {
    this.output.connect(this.limiter);
    if (live) {
      const channel = new InstrumentChannel(this.output);
      this.channel = channel;
      this.ready = channel.set(live.instrument, live.choice, live.bpm);
    } else {
      this.ready = Promise.all(
        lanes.map(async (lane) => {
          const addedPart = lane.part >= ownParts ? added[lane.part - ownParts] : undefined;
          const instrument = addedPart ? jamAddedInstrument(addedPart) : undefined;
          const buffer = await renderJamPartSound(trackFile, lane.part, lane.pitch, instrument ?? undefined);
          this.buffers.set(lane.note, buffer);
        })
      ).then(() => undefined);
    }
    this.ready.then(() => {
      this.loaded = true;
    });
  }

  // A lane's sound at `time` (audio time), at `velocity` and `volume` (0-1);
  // false while its sound is still being prepared
  play(note: number, time: number, velocity: number, volume: number): boolean {
    if (this.channel && this.live) {
      const played = this.live.notes.get(note);
      if (!this.loaded || played === undefined) return false;
      const scaled = Math.max(1, Math.round(velocity * volume));
      this.channel.noteOn(played, scaled, time);
      this.channel.noteOff(played, time + LIVE_HOLD_S);
      return true;
    }
    const buffer = this.buffers.get(note);
    if (!buffer) return false;
    const gain = new Tone.Gain((velocity / 127) * volume).connect(this.output);
    const player = new Tone.Player(buffer).connect(gain);
    player.onstop = () => {
      player.dispose();
      gain.dispose();
    };
    player.start(time);
    return true;
  }

  dispose() {
    this.channel?.dispose();
    this.output.dispose();
    this.limiter.dispose();
    this.buffers.clear();
  }
}
