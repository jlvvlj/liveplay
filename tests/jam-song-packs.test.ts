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
import { abletonNoteKey } from '../apps/desktop/src/renderer/utils/abletonImport';
import { jamSongPack } from '../apps/desktop/src/renderer/components/lesson-engine/jamSongPacks';
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
      await new Promise((resolve) => server.close(resolve));
      songs.flush();
      fs.rmSync(songsDir, { recursive: true, force: true });
    }
  });
});
