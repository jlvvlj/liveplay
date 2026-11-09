/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { createJamHttp } from '../server/jamHttp';
import { createJamSongStore } from '../server/jamSongStore';
import { abletonChordClasses, abletonNoteKey } from '../apps/desktop/src/renderer/utils/abletonImport';
import { jamSongPack } from '../apps/desktop/src/renderer/components/lesson-engine/jamSongPacks';
import { jamImportedTranspose, jamWrittenTranspose } from '../apps/desktop/src/renderer/components/lesson-engine/jamRowsKey';
import { soundsAtNote } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/engines/pitchCheck';
import type { JamAbletonSong } from '../apps/desktop/src/renderer/components/lesson-engine/jamRoomProtocol';
import type { LessonStep } from '../apps/desktop/src/renderer/types/lesson';

const step = (note: number, offset: number, duration: number, velocity = 100): LessonStep => ({
  tick: 0,
  note,
  dur: 240,
  velocity,
  slice: { offset, duration },
});
const track = (name: string, laneLabels: Record<number, string>, steps: LessonStep[]) => ({
  name,
  audio: name,
  lesson: { id: name, title: name, instrument: 'pads' as const, bpm: 120, steps, laneLabels },
});

// As "Else - Paris" came in: tracks of one key, a percussion track with a
// flam, and melodic tracks
const song: JamAbletonSong = {
  seconds: 8,
  tracks: [
    track('Kick', { 36: 'Kick' }, [step(36, 0, 0.5), step(36, 1, 2)]),
    track('Perc', { 36: 'C#1', 37: 'D#1 E1' }, [step(36, 0, 1), step(37, 2, 1)]),
    track('Bass', { 36: 'C#1', 37: 'G#1' }, [step(36, 0, 2, 60), step(36, 4, 2, 90), step(36, 6, 1, 127), step(37, 2, 2)]),
  ],
};

describe('an imported song as a sound pack', () => {
  it('reads Ableton note names as keys, and nothing else', () => {
    expect(abletonNoteKey('C3')).toBe(60);
    expect(abletonNoteKey('C#1')).toBe(37);
    expect(abletonNoteKey('C-2')).toBe(0);
    expect(abletonNoteKey('D#1 E1')).toBeNull();
    expect(abletonNoteKey('Fm')).toBeNull();
    expect(abletonNoteKey('Kick')).toBeNull();
  });

  it('makes a track of many pitches an instrument and every other sound a pad', () => {
    const pack = jamSongPack({ id: 'SONG', title: 'Else - Paris', ableton: song });
    expect(pack.kit.map((sound) => sound.name)).toEqual(['Kick', 'Perc C#1', 'Perc D#1 E1']);
    expect(pack.instruments).toHaveLength(1);
    expect(pack.instruments[0]).toMatchObject({ track: 2, name: 'Bass' });
    expect(pack.instruments[0].notes.map((note) => note.root)).toEqual([37, 44]);
  });

  it('keeps every slice of a lane, for the sampler to hear', () => {
    const pack = jamSongPack({ id: 'SONG', title: 'Else - Paris', ableton: song });
    expect(pack.kit[0]).toMatchObject({
      audio: 'Kick',
      slices: [
        { offset: 0, duration: 0.5 },
        { offset: 1, duration: 2 },
      ],
    });
    expect(pack.instruments[0].notes[1]).toMatchObject({ audio: 'Bass', slices: [{ offset: 2, duration: 2 }] });
  });

  it('reads chord names as pitch classes, and nothing else', () => {
    expect(abletonChordClasses('Fm')).toEqual([5, 8, 0]);
    expect(abletonChordClasses('C#maj7/E')).toEqual([1, 5, 8, 0]);
    expect(abletonChordClasses('D#1 E1')).toBeNull();
    expect(abletonChordClasses('Bass')).toBeNull();
  });

  describe("a room's rows", () => {
    // A lane per label, playing `dur` ticks
    const lanes = (name: string, labels: [string, number][]) =>
      track(
        name,
        Object.fromEntries(labels.map(([label], lane) => [36 + lane, label])),
        labels.map(([, dur], lane) => ({ ...step(36 + lane, lane, 1), dur }))
      );
    const of = (...tracks: JamAbletonSong['tracks']): JamAbletonSong => ({ seconds: 8, tracks });

    it('move to the key of "Else - Paris": C# minor, from its bass', () => {
      const else_ = of(
        lanes('Kick', [['Kick', 120]]),
        lanes('Perc', [['C#1', 120], ['D1', 120], ['D#1', 120], ['D#1 E1', 120]]),
        lanes('Arp', [['C#1', 1920], ['E1', 1920], ['F#1', 1920], ['G#1', 1920], ['A#2', 1920], ['B2', 3840], ['C#3', 1920], ['D#3', 11520], ['E3', 3840], ['F#3', 3840], ['G#3', 11520]]),
        lanes('Lead', [['C#4', 14400], ['D#4', 19480]]),
        lanes('Bass', [['C#1', 7680], ['E1', 7680], ['F#1', 7440], ['G#1', 7680]])
      );
      // A up to C#: every row a note of the song (C# E F# G# B)
      expect(jamImportedTranspose(else_)).toBe(4);
    });

    it('follow a song of chords', () => {
      expect(jamImportedTranspose(of(lanes('Pad', [['Dm', 960], ['Gm', 960], ['Am', 960], ['F', 960]])))).toBe(5);
    });

    const written = (pitches: number[]) => pitches.map((pitch, step) => ({ pitch, step, length: 4, velocity: 100 }));

    it('follow the notes of a song written in the Daw', () => {
      // C minor: C Eb F G Bb, in a part of its own
      expect(jamWrittenTranspose({ parts: [written([48, 51, 53, 55, 58])] }, 1)).toBe(3);
      // Already A minor, and nothing at all
      expect(jamWrittenTranspose({ parts: [written([45, 48, 50, 52, 55])] }, 1)).toBe(0);
      expect(jamWrittenTranspose({ parts: [[]] }, 1)).toBe(0);
    });

    it('leave out the pads of a kit in a written song', () => {
      const kit = { track: 'a', sound: 'kit', drum: 0 };
      expect(jamWrittenTranspose({ parts: [written([48, 51, 53, 55, 58]), written([37, 38])], added: [kit] }, 1)).toBe(3);
    });

    it('stay where they are for a song without pitches', () => {
      expect(jamImportedTranspose(of(lanes('Kick', [['Kick', 120]]), lanes('Drums', [['Sound 1', 120], ['Sound 2', 120]])))).toBe(0);
    });
  });

  it('is served for the imported songs offered to rooms only', async () => {
    const songsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-packs-'));
    const songs = createJamSongStore(songsDir);
    const made = { bpm: 120, file: 'ableton', transpose: 0, edit: null, ableton: song };
    const offered = songs.add({ ...made, title: 'Offered', offered: true });
    songs.add({ ...made, title: 'Not offered', offered: false });
    songs.add({ title: 'Written here', bpm: 120, file: 'empty-120.wav', transpose: 0, edit: null, offered: true });
    const handler = createJamHttp({ songsDir, songs, repoRoot: songsDir });
    const server = http.createServer((req, res) => void handler(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/jam-song-packs`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([jamSongPack({ id: offered.id, title: 'Offered', ableton: song })]);
    } finally {
      // Node 18's close() waits for the connection fetch keeps open
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      songs.flush();
      fs.rmSync(songsDir, { recursive: true, force: true });
    }
  });
});

describe('telling which note a recording plays', () => {
  const RATE = 48000;
  const sine = (note: number, level = 1) => {
    const hz = 440 * 2 ** ((note - 69) / 12);
    return Float32Array.from({ length: 8192 }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / RATE));
  };
  const mix = (a: Float32Array, b: Float32Array) => a.map((value, i) => value + b[i]);

  it('hears a note at its pitch, high or low', () => {
    for (const note of [37, 44, 59, 68, 75]) expect(soundsAtNote(sine(note), RATE, note)).toBe(true);
  });

  it('does not hear another note, or an octave away', () => {
    expect(soundsAtNote(sine(40), RATE, 68)).toBe(false);
    expect(soundsAtNote(sine(56), RATE, 68)).toBe(false);
    expect(soundsAtNote(sine(68), RATE, 56)).toBe(false);
    expect(soundsAtNote(sine(69), RATE, 68)).toBe(false);
  });

  it('does not hear a high note over a low one still ringing', () => {
    expect(soundsAtNote(mix(sine(68, 0.5), sine(40)), RATE, 68)).toBe(false);
  });
});
