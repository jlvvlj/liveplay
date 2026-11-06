import * as Tone from 'tone';
import { InstrumentChannel } from './instruments/channel';
import { findInstrument, jamRowNote } from './instruments/catalog';
import type { InstrumentDef } from './instruments/types';
import type { JamRoomSound } from './jamRoomProtocol';

// Other players' sounds in a jam room: each player's chosen instrument, as
// they set it, played live here through its own channel (effects and level)
// into the same notes bus as this player's.

interface Voice {
  key: string;
  channel: InstrumentChannel;
  instrument: InstrumentDef;
  ready: boolean;
}

export class JamRemoteVoices {
  private voices = new Map<string, Voice>();
  private level = 0;

  constructor(private output: Tone.InputNode) {}

  // Sets player `id`'s instrument as they chose it
  set(id: string, sound: JamRoomSound | null, instruments: InstrumentDef[], bpm: number): void {
    const instrument = sound ? findInstrument(instruments, sound.instrument) : undefined;
    if (!sound || !instrument) {
      this.remove(id);
      if (sound) console.warn(`[JamRemoteVoices] Player ${id} plays an instrument this device does not have: ${sound.instrument}`);
      return;
    }
    const key = JSON.stringify([sound, bpm]);
    let voice = this.voices.get(id);
    if (voice?.key === key) return;
    if (!voice) {
      const channel = new InstrumentChannel(this.output);
      channel.level = this.level;
      voice = { key, channel, instrument, ready: false };
      this.voices.set(id, voice);
    }
    const current = voice;
    if (current.instrument.id !== instrument.id) current.ready = false;
    current.key = key;
    current.instrument = instrument;
    current.channel.set(instrument, sound, bpm).then(
      () => {
        if (this.voices.get(id) === current) current.ready = true;
      },
      (err) => console.error(`[JamRemoteVoices] Could not load ${instrument.name} for player ${id}:`, err)
    );
  }

  // Every remote player's level, in dB
  setLevel(db: number): void {
    this.level = db;
    for (const voice of this.voices.values()) voice.channel.level = db;
  }

  // Plays player `id`'s row `row` (of the song's `rows`) at audio time
  // `time`, for `length` seconds or until released; false while their
  // instrument is still loading
  play(id: string, row: number, rows: number[], time: number, velocity: number, length?: number): boolean {
    const voice = this.voices.get(id);
    if (!voice?.ready) return false;
    const note = jamRowNote(voice.instrument, row, rows);
    voice.channel.noteOn(note, velocity, time);
    if (length !== undefined) voice.channel.noteOff(note, time + length);
    return true;
  }

  release(id: string, row: number, rows: number[], time: number): void {
    const voice = this.voices.get(id);
    if (voice) voice.channel.noteOff(jamRowNote(voice.instrument, row, rows), time);
  }

  // Drops the sounds of players no longer in the room
  keepOnly(ids: string[]): void {
    for (const id of [...this.voices.keys()]) if (!ids.includes(id)) this.remove(id);
  }

  remove(id: string): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    this.voices.delete(id);
    voice.channel.allOff();
    setTimeout(() => voice.channel.dispose(), 300);
  }

  dispose(): void {
    for (const id of [...this.voices.keys()]) this.remove(id);
  }
}
