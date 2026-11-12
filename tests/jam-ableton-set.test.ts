import fs from 'fs';
import path from 'path';
import { abletonLiveSet, type AbletonSample, type AbletonSong } from '../apps/desktop/src/renderer/components/lesson-engine/jamAbletonSet';

const dir = path.join(__dirname, '../apps/desktop/src/renderer/components/lesson-engine/ableton');
const templates = {
  liveSet: fs.readFileSync(path.join(dir, 'live-set.xml'), 'utf8'),
  midiTrack: fs.readFileSync(path.join(dir, 'midi-track.xml'), 'utf8'),
  audioTrack: fs.readFileSync(path.join(dir, 'audio-track.xml'), 'utf8'),
  sampler: fs.readFileSync(path.join(dir, 'sampler.xml'), 'utf8'),
};

const sample = (name: string, frames = 44100): AbletonSample => ({
  path: `Samples/Imported/${name}.wav`,
  frames,
  sampleRate: 44100,
  bytes: 44 + frames * 8,
});

const song: AbletonSong = {
  bpm: 96,
  beats: 32,
  tracks: [
    {
      kind: 'midi',
      name: 'Keys & Bass',
      color: 9,
      on: true,
      release: 1000,
      notes: [
        { key: 48, time: 0, duration: 1, velocity: 100 },
        { key: 55, time: 1.5, duration: 0.5, velocity: 80 },
        { key: 48, time: 2, duration: 1, velocity: 90 },
      ],
      zones: [
        { name: 'Keys C2', sample: sample('Keys C2'), root: 48, low: 0, high: 51, volume: 1 },
        { name: 'Keys G2', sample: sample('Keys G2'), root: 55, low: 52, high: 127, volume: 1 },
      ],
    },
    {
      kind: 'midi',
      name: 'Drums',
      color: 3,
      on: false,
      release: 500,
      notes: [{ key: 36, time: 0, duration: 0.25, velocity: 127 }],
      zones: [{ name: 'Kick', sample: sample('Kick'), root: 36, low: 36, high: 36, volume: 0.5 }],
    },
    { kind: 'audio', name: 'Vocal', color: 20, on: true, sample: sample('Vocal', 441000), bpm: 120, volume: 0.8 },
  ],
};

describe('abletonLiveSet', () => {
  const xml = abletonLiveSet(song, templates);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  it('is well-formed XML with every template value filled', () => {
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(xml).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('has a track per track, named, in order, with the song tempo', () => {
    const tracks = Array.from(doc.querySelectorAll('LiveSet > Tracks > *'));
    expect(tracks.map((track) => track.tagName)).toEqual(['MidiTrack', 'MidiTrack', 'AudioTrack']);
    expect(tracks.map((track) => track.querySelector(':scope > Name > UserName')?.getAttribute('Value'))).toEqual([
      'Keys & Bass',
      'Drums',
      'Vocal',
    ]);
    expect(new Set(tracks.map((track) => track.getAttribute('Id'))).size).toBe(3);
    expect(doc.querySelector('MainTrack Tempo > Manual')?.getAttribute('Value')).toBe('96');
  });

  it('gives every target and pointee its own id, below NextPointeeId', () => {
    const ids = Array.from(doc.querySelectorAll('*'))
      .filter((element) => /Target(s\.\d+)?$|^Pointee$/.test(element.tagName) && element.hasAttribute('Id'))
      .map((element) => Number(element.getAttribute('Id')));
    expect(new Set(ids).size).toBe(ids.length);
    const next = Number(doc.querySelector('LiveSet > NextPointeeId')?.getAttribute('Value'));
    expect(Math.max(...ids)).toBeLessThan(next);
  });

  it('puts each MIDI track’s notes in one clip, by key, and its sounds in a Sampler', () => {
    const keys = doc.querySelector('MidiTrack');
    const clip = keys!.querySelector('MainSequencer ClipTimeable ArrangerAutomation Events > MidiClip');
    expect(clip?.querySelector('CurrentEnd')?.getAttribute('Value')).toBe('32');
    const keyTracks = Array.from(clip!.querySelectorAll('KeyTrack'));
    expect(keyTracks.map((track) => track.querySelector('MidiKey')?.getAttribute('Value'))).toEqual(['48', '55']);
    expect(keyTracks[0].querySelectorAll('MidiNoteEvent')).toHaveLength(2);
    const zones = Array.from(keys!.querySelectorAll('Devices > MultiSampler SampleParts > MultiSamplePart'));
    expect(zones.map((zone) => zone.querySelector('RootKey')?.getAttribute('Value'))).toEqual(['48', '55']);
    expect(zones[1].querySelector('KeyRange > Min')?.getAttribute('Value')).toBe('52');
    expect(zones[0].querySelector('SampleRef FileRef RelativePath')?.getAttribute('Value')).toBe('Samples/Imported/Keys C2.wav');
  });

  it('switches off a muted track and keeps a part’s level on its zone', () => {
    const drums = doc.querySelectorAll('MidiTrack')[1];
    expect(drums.querySelector('Mixer > Speaker > Manual')?.getAttribute('Value')).toBe('false');
    expect(drums.querySelector('MultiSamplePart > Volume')?.getAttribute('Value')).toBe('0.5');
  });

  it('warps a recording from its own tempo', () => {
    const clip = doc.querySelector('AudioTrack MainSequencer Sample ArrangerAutomation Events > AudioClip');
    const markers = Array.from(clip!.querySelectorAll('WarpMarkers > WarpMarker'));
    expect(markers[1].getAttribute('SecTime')).toBe('10');
    expect(markers[1].getAttribute('BeatTime')).toBe('20');
    expect(clip!.querySelector('SampleVolume')?.getAttribute('Value')).toBe('0.8');
  });
});
