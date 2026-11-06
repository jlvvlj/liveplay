import * as Tone from 'tone';
import { createInstrument } from './catalog';
import { EffectsChain } from './effects';
import type { InstrumentChoice, InstrumentDef, LiveInstrument } from './types';

// One track's sound: its instrument, then its effects, then its level, into
// `destination`. Changing the instrument makes a new one; changing its
// parameters or effects updates them in place.
export class InstrumentChannel {
  private instrument: LiveInstrument | null = null;
  private instrumentId = '';
  private readonly effects = new EffectsChain();
  private readonly volume = new Tone.Volume();

  constructor(destination: Tone.InputNode) {
    this.effects.output.connect(this.volume);
    this.volume.connect(destination);
  }

  // Resolves once the chosen instrument can sound
  set(instrument: InstrumentDef, choice: InstrumentChoice, bpm: number): Promise<void> {
    if (instrument.id !== this.instrumentId || !this.instrument) {
      this.instrument?.allOff();
      const old = this.instrument;
      // The old instrument's last notes fade before it goes
      if (old) setTimeout(() => old.dispose(), 300);
      this.instrument = createInstrument(instrument, choice.params);
      this.instrument.output.connect(this.effects.input);
      this.instrumentId = instrument.id;
    } else {
      this.instrument.setParams(choice.params);
    }
    this.effects.set(choice.effects, bpm);
    return this.instrument.ready;
  }

  // Level in dB
  set level(db: number) {
    this.volume.volume.value = db;
  }

  noteOn(note: number, velocity: number, time: number) {
    this.instrument?.noteOn(note, velocity, time);
  }

  noteOff(note: number, time: number) {
    this.instrument?.noteOff(note, time);
  }

  allOff() {
    this.instrument?.allOff();
  }

  dispose() {
    this.instrument?.dispose();
    this.effects.dispose();
    this.volume.dispose();
  }
}
