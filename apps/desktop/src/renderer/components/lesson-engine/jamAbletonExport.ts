import * as Tone from 'tone';
import liveSetTemplate from './ableton/live-set.xml?raw';
import midiTrackTemplate from './ableton/midi-track.xml?raw';
import audioTrackTemplate from './ableton/audio-track.xml?raw';
import samplerTemplate from './ableton/sampler.xml?raw';
import { abletonLiveSet, type AbletonNote, type AbletonSample, type AbletonTrack, type AbletonZone } from './jamAbletonSet';
import { jamAddedInstrument, jamAddedPartName, type JamAddedPart } from './jamAddedParts';
import { gridTracks } from './jamGridTracks';
import type { JamTrackNames } from './jamTrackEdits';
import { renderJamClip, renderJamDrum, SAMPLE_RATE as JAM_SYNTH_RATE } from './jamSynth';
import { jamSoundUrl } from './jamSoundFiles';
import { jamPartTracks, type JamTrackInstruments } from './jamTrackInstruments';
import { renderJamPartNote, swung } from './jamTrackRender';
import { jamTrackParts, type JamTrack, type JamTrackNote } from './jamTracks';
import { zipFiles } from './jamZip';
import { captureNotes } from './instruments/capture';
import { findInstrument } from './instruments/catalog';
import { PAD_BASE_NOTE, type InstrumentDef } from './instruments/types';

// A Daw song as an Ableton Live project: a folder with its Live Set and the
// sounds it plays in Samples/Imported, zipped. Every track of the grid is a
// MIDI track with its notes (swung as the Daw plays them) and its sounds in a
// Sampler, a zone per drum or per note it plays, each sounding as it does in
// the Daw; an imported song's recordings are audio tracks.

export interface JamAbletonExport {
  title: string;
  bpm: number;
  bars: number;
  track: JamTrack;
  // Each part's notes, as edited, and the tracks added in the grid
  notes: JamTrackNote[][];
  added: JamAddedPart[];
  // Each part's level (0-1) and whether it is heard (not muted, not left out of a solo)
  levels: number[];
  heard: boolean[];
  // The names given to tracks in the grid
  names: JamTrackNames;
  // The instrument each track plays live
  choices: JamTrackInstruments;
  instruments: InstrumentDef[];
  // The gain the Daw plays every part at
  scale: number;
}

export interface JamAbletonExportStep {
  track: string;
  done: number;
  total: number;
}

// A sound Live plays: both channels, at its rate
interface Sound {
  channels: Float32Array[];
  sampleRate: number;
}

// Live's track colors, one after the other
const COLORS = [26, 9, 14, 3, 18, 22, 5, 11, 16, 1, 20, 7];
// A note is captured held at most this long (s); a Sampler holds at most this many notes
const LONGEST_HOLD_S = 8;
const MOST_ZONES = 24;
// How long a sound rings on once its note is let go, at most (ms)
const LONGEST_RELEASE_MS = 10000;

// The notes a melodic track plays, each with its longest hold; at most
// MOST_ZONES of them, evenly over the range, the others played re-pitched
function playedPitches(notes: JamTrackNote[]): { pitch: number; length: number }[] {
  const longest = new Map<number, number>();
  for (const note of notes) longest.set(note.pitch, Math.max(longest.get(note.pitch) ?? 0, note.length));
  const pitches = [...longest.keys()].sort((a, b) => a - b);
  const kept =
    pitches.length <= MOST_ZONES
      ? pitches
      : Array.from({ length: MOST_ZONES }, (_, i) => pitches[Math.round((i * (pitches.length - 1)) / (MOST_ZONES - 1))]);
  return kept.map((pitch) => ({ pitch, length: Math.max(...pitches.filter((p) => nearest(kept, p) === pitch).map((p) => longest.get(p)!)) }));
}

const nearest = (roots: number[], pitch: number) =>
  roots.reduce((best, root) => (Math.abs(root - pitch) < Math.abs(best - pitch) ? root : best), roots[0]);

// Keys from `low` to `high` for each root: every key plays its nearest root
function zoneRanges(roots: number[]): { low: number; high: number }[] {
  return roots.map((root, i) => ({
    low: i === 0 ? 0 : Math.floor((roots[i - 1] + root) / 2) + 1,
    high: i === roots.length - 1 ? 127 : Math.floor((root + roots[i + 1]) / 2),
  }));
}

async function decode(url: string): Promise<Sound> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} could not be loaded (${response.status})`);
  const audio = await new OfflineAudioContext(2, 1, Tone.getContext().sampleRate).decodeAudioData(await response.arrayBuffer());
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).slice());
  return { channels: channels.length > 1 ? channels : [channels[0], channels[0]], sampleRate: audio.sampleRate };
}

// A 32-bit float stereo WAV, at the gain given, so nothing louder than full scale is clipped
function encodeWavFloat({ channels, sampleRate }: Sound, gain: number): Uint8Array<ArrayBuffer> {
  const frames = channels[0].length;
  const buffer = new ArrayBuffer(44 + frames * 8);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  text(36, 'data');
  view.setUint32(40, frames * 8, true);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < 2; c++) view.setFloat32(44 + i * 8 + c * 4, channels[Math.min(c, channels.length - 1)][i] * gain, true);
  return new Uint8Array(buffer);
}

// A note as Live names it (middle C is C3)
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (note: number) => `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 2}`;

const fileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';

export async function exportJamAbletonProject(song: JamAbletonExport, onStep: (step: JamAbletonExportStep) => void): Promise<Blob> {
  const { track, notes, added, bpm } = song;
  const own = jamTrackParts(track);
  const partTracks = jamPartTracks(own, added);
  const addedOf = (part: number) => (part < own.length ? undefined : added[part - own.length]);
  const sixteenth = 60 / bpm / 4;

  // The grid's tracks in its order, each with its parts
  const groups: { key: string; parts: number[] }[] = [];
  partTracks.forEach((partTrack, part) => {
    const group = groups.find((candidate) => candidate.key === partTrack.key);
    if (group) group.parts.push(part);
    else groups.push({ key: partTrack.key, parts: [part] });
  });
  // Each track named as the grid names it
  const trackNames = new Map(gridTracks(own, added, song.names).map((gridTrack) => [gridTrack.id, gridTrack.name]));
  const trackName = (key: string) => {
    const name = trackNames.get(key);
    if (name === undefined) throw new Error(`No grid track ${key}`);
    return name;
  };
  const partName = (part: number) => {
    const extra = addedOf(part);
    return extra ? jamAddedPartName(extra) : own[part].name;
  };

  const folder = `${fileName(song.title)} Project`;
  const files: { path: string; data: Uint8Array<ArrayBuffer> }[] = [];
  const usedNames = new Set<string>();
  const addSample = (name: string, sound: Sound): AbletonSample => {
    let base = fileName(name);
    for (let n = 2; usedNames.has(base.toLowerCase()); n++) base = `${fileName(name)} ${n}`;
    usedNames.add(base.toLowerCase());
    const path = `Samples/Imported/${base}.wav`;
    const data = encodeWavFloat(sound, song.scale);
    files.push({ path: `${folder}/${path}`, data });
    return { path, frames: sound.channels[0].length, sampleRate: sound.sampleRate, bytes: data.length };
  };

  const tracks: AbletonTrack[] = [];
  for (const [index, { key, parts }] of groups.entries()) {
    const name = trackName(key);
    const color = COLORS[index % COLORS.length];
    const on = parts.some((part) => song.heard[part]);
    onStep({ track: name, done: index, total: groups.length });

    // An imported song's recording plays as it is
    if (own[parts[0]]?.recorded) {
      const recording = track.recorded![parts[0] - own.findIndex((part) => part.recorded)];
      const sample = addSample(name, await decode(recording.url));
      tracks.push({ kind: 'audio', name, color, on, sample, bpm: track.bpm, volume: song.levels[parts[0]] ?? 1 });
      continue;
    }

    const drum = partTracks[parts[0]].kind === 'drum';
    const keyOf = (part: number, note: JamTrackNote) => (drum ? PAD_BASE_NOTE + partTracks[part].pad : note.pitch);
    const choice = song.choices[key];
    const instrument = choice && findInstrument(song.instruments, choice.instrument);
    const zones: AbletonZone[] = [];
    const level = (part: number) => song.levels[part] ?? 1;

    if (choice && instrument) {
      // A live instrument: each pad, or each note it plays, recorded
      const wanted = drum
        ? parts.map((part) => ({ part, note: PAD_BASE_NOTE + partTracks[part].pad, hold: sixteenth }))
        : (notes[parts[0]].length ? playedPitches(notes[parts[0]]) : [{ pitch: 60, length: 4 }]).map(({ pitch, length }) => ({
            part: parts[0],
            note: pitch,
            hold: Math.min(LONGEST_HOLD_S, length * sixteenth),
          }));
      const sounds = await captureNotes(
        instrument,
        choice,
        wanted.map(({ note, hold }) => ({ note, velocity: 127, hold })),
        bpm,
        (done) => onStep({ track: name, done: index + done / wanted.length, total: groups.length })
      );
      const ranges = drum ? null : zoneRanges(wanted.map(({ note }) => note));
      const rate = Tone.getContext().sampleRate;
      wanted.forEach(({ part, note }, i) => {
        const zoneName = drum ? partName(part) : `${name} ${noteName(note)}`;
        zones.push({
          name: zoneName,
          sample: addSample(zoneName, { channels: sounds[i], sampleRate: rate }),
          root: note,
          low: ranges ? ranges[i].low : note,
          high: ranges ? ranges[i].high : note,
          volume: level(part),
        });
      });
    } else {
      // The song's own sound, or an added track's, made as the Daw makes it
      for (const part of parts) {
        const extra = addedOf(part);
        const sampled = part >= track.drums.length + track.layers.length && !extra;
        const pitches = drum ? [{ pitch: 0, length: 1 }] : notes[part].length ? playedPitches(notes[part]) : [{ pitch: 60, length: 4 }];
        const ranges = zoneRanges(pitches.map(({ pitch }) => pitch));
        if (sampled) {
          const { kind, sounds } = track.sampled![part - track.drums.length - track.layers.length];
          const recorded = kind === 'drum' ? sounds.slice(0, 1) : sounds;
          const roots = recorded.map((sound) => sound.root);
          const order = roots.map((_, i) => i).sort((a, b) => roots[a] - roots[b]);
          const sortedRanges = zoneRanges(order.map((i) => roots[i]));
          for (const [z, i] of order.entries()) {
            const sound = recorded[i];
            const decoded = await decode(jamSoundUrl(sound.file));
            const gain = 127 / sound.velocity;
            const zoneName = drum ? partName(part) : `${name} ${noteName(sound.root)}`;
            zones.push({
              name: zoneName,
              sample: addSample(zoneName, { ...decoded, channels: decoded.channels.map((c) => c.map((x) => x * gain)) }),
              root: drum ? PAD_BASE_NOTE + partTracks[part].pad : sound.root,
              low: drum ? PAD_BASE_NOTE + partTracks[part].pad : sortedRanges[z].low,
              high: drum ? PAD_BASE_NOTE + partTracks[part].pad : sortedRanges[z].high,
              volume: level(part),
            });
          }
          continue;
        }
        const madeBy = extra ? jamAddedInstrument(extra) : null;
        for (const [z, { pitch, length }] of pitches.entries()) {
          const note: JamTrackNote = { pitch, step: 0, length, velocity: 127 };
          let sound: Sound;
          if (!extra) sound = { channels: renderJamPartNote(track, part, note, Tone.getContext().sampleRate), sampleRate: Tone.getContext().sampleRate };
          else if (madeBy && 'drum' in madeBy) sound = { channels: [renderJamDrum(madeBy.drum)], sampleRate: JAM_SYNTH_RATE };
          else if (madeBy) sound = { channels: [renderJamClip({ ...madeBy.patch, hold: length * sixteenth }, pitch)], sampleRate: JAM_SYNTH_RATE };
          else throw new Error(`${partName(part)} has no sound to export`);
          const key = drum ? PAD_BASE_NOTE + partTracks[part].pad : pitch;
          const zoneName = drum ? partName(part) : `${name} ${noteName(pitch)}`;
          zones.push({
            name: zoneName,
            sample: addSample(zoneName, sound),
            root: key,
            low: drum ? key : ranges[z].low,
            high: drum ? key : ranges[z].high,
            volume: level(part),
          });
        }
      }
    }

    const midiNotes: AbletonNote[] = parts.flatMap((part) =>
      notes[part].map((note) => ({
        key: keyOf(part, note),
        time: swung(track, note.step) / 4,
        duration: note.length / 4,
        velocity: note.velocity,
      }))
    );
    const release = Math.min(
      LONGEST_RELEASE_MS,
      Math.max(50, ...zones.map((zone) => (zone.sample.frames / zone.sample.sampleRate) * 1000))
    );
    tracks.push({ kind: 'midi', name, color, on, notes: midiNotes, zones, release });
  }
  onStep({ track: '', done: groups.length, total: groups.length });

  const xml = abletonLiveSet(
    { bpm, beats: song.bars * 4, tracks },
    { liveSet: liveSetTemplate, midiTrack: midiTrackTemplate, audioTrack: audioTrackTemplate, sampler: samplerTemplate }
  );
  const gzipped = await new Response(new Blob([xml]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  files.unshift({ path: `${folder}/${fileName(song.title)}.als`, data: new Uint8Array(gzipped) });
  return zipFiles(files);
}
