import * as Tone from 'tone';
import { renderJamSound } from './jamRenderer';
import type { JamSampleSound, JamSoundPreset } from './jamSynth';
import type { JamRoomSound } from './jamRoomProtocol';

// Other players' sounds in a jam room: each player's chosen sound is rendered
// here, one clip per row like the player's own, and their notes play through
// the same notes bus (echo and reverb) as this player's.

const POOL_SIZE = 4;

interface Voice {
  key: string;
  players: Map<number, Tone.Player[]>;
  next: Map<number, number>;
  blobs: string[];
}

const audioPath = (file: string) => (/^(blob|https?):|^\//.test(file) ? file : `/audio/${file}`);

export class JamRemoteVoices {
  private voices = new Map<string, Voice>();
  private pending = new Map<string, string>();

  constructor(private output: Tone.InputNode) {}

  // Renders `sound` for player `id` unless it already has it
  async set(
    id: string,
    sound: JamRoomSound | null,
    notes: number[],
    presets: JamSoundPreset[],
    references: JamSampleSound[]
  ): Promise<void> {
    const key = JSON.stringify([sound, notes]);
    if (this.voices.get(id)?.key === key || this.pending.get(id) === key) return;
    this.pending.set(id, key);
    const preset = sound ? presets.find((candidate) => candidate.id === sound.id) : undefined;
    const reference = sound ? references.find((candidate) => candidate.id === sound.id) : undefined;
    let samples: { [note: number]: string };
    let blobs: string[] = [];
    if (preset) {
      samples = await renderJamSound('kit' in preset ? { kit: preset.kit } : { patch: sound?.patch ?? preset.patch }, notes);
      blobs = Object.values(samples);
    } else if (reference) {
      samples = reference.samples;
    } else {
      this.pending.delete(id);
      throw new Error(`Player ${id} plays a sound this device does not have: ${sound?.id ?? 'none'}`);
    }
    if (this.pending.get(id) !== key) {
      blobs.forEach((url) => URL.revokeObjectURL(url));
      return;
    }
    this.pending.delete(id);
    const players = new Map<number, Tone.Player[]>();
    await Promise.all(
      Object.entries(samples).map(async ([note, file]) => {
        const pool = Array.from({ length: POOL_SIZE }, () => new Tone.Player().connect(this.output));
        await Promise.all(pool.map((player) => player.load(audioPath(file))));
        players.set(Number(note), pool);
      })
    );
    this.remove(id);
    this.voices.set(id, { key, players, next: new Map(), blobs });
  }

  // Plays player `id`'s row `note` at audio time `time`; false when its sound
  // is still being prepared
  play(id: string, note: number, time: number, volume: number): boolean {
    const voice = this.voices.get(id);
    const pool = voice?.players.get(note);
    if (!voice || !pool) return false;
    const index = voice.next.get(note) ?? 0;
    voice.next.set(note, index + 1);
    const player = pool.find((candidate) => candidate.state !== 'started') ?? pool[index % pool.length];
    if (player.state === 'started') player.stop(time);
    player.volume.value = volume === 0 ? -Infinity : -6 + (volume - 1) * 20;
    player.start(time);
    return true;
  }

  // Drops the sounds of players no longer in the room
  keepOnly(ids: string[]): void {
    for (const id of [...this.voices.keys(), ...this.pending.keys()]) {
      if (ids.includes(id)) continue;
      this.pending.delete(id);
      this.remove(id);
    }
  }

  remove(id: string): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    this.voices.delete(id);
    for (const pool of voice.players.values()) pool.forEach((player) => player.dispose());
    voice.blobs.forEach((url) => URL.revokeObjectURL(url));
  }

  dispose(): void {
    for (const id of [...this.voices.keys()]) this.remove(id);
    this.pending.clear();
  }
}
