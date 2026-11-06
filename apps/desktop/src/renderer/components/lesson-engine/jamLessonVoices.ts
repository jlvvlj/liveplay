import * as Tone from 'tone';
import { renderJamPartSound } from './jamAudition';
import { jamAddedInstrument, type JamAddedPart } from './jamAddedParts';
import type { JamLessonLane } from './jamLessonRooms';

// A lesson room's hits, everyone's, played with the lesson track's own sound:
// each lane's part on its pitch, rendered once when the room's lesson is known.

// Parts render unscaled: held under 0 dBFS, like the mixer's parts
const LEVEL_DB = -6;

export class JamLessonVoices {
  private readonly output = new Tone.Volume(LEVEL_DB);
  private readonly limiter = new Tone.Limiter(-1).toDestination();
  private buffers = new Map<number, Tone.ToneAudioBuffer>();
  readonly ready: Promise<void>;

  constructor(trackFile: string, lanes: JamLessonLane[], added: JamAddedPart[], ownParts: number) {
    this.output.connect(this.limiter);
    this.ready = Promise.all(
      lanes.map(async (lane) => {
        const addedPart = lane.part >= ownParts ? added[lane.part - ownParts] : undefined;
        const instrument = addedPart ? jamAddedInstrument(addedPart) : undefined;
        const buffer = await renderJamPartSound(trackFile, lane.part, lane.pitch, instrument ?? undefined);
        this.buffers.set(lane.note, buffer);
      })
    ).then(() => undefined);
  }

  // A lane's sound at `time` (audio time), at `velocity` and `volume` (0-1);
  // false while its sound is still being rendered
  play(note: number, time: number, velocity: number, volume: number): boolean {
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
    this.output.dispose();
    this.limiter.dispose();
    this.buffers.clear();
  }
}
