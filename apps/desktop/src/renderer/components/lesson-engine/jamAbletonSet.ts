// A Live Set (the XML of an Ableton Live .als, before it is gzipped) made from
// a song: a MIDI track per track with notes, its notes in one arrangement clip
// and its sounds in a Sampler (a zone per sound), and an audio track per
// recording. It is built from Live's own defaults (ableton/*.xml, see
// scripts/make-ableton-export-templates.mjs), with the samples in the
// project's Samples/Imported folder.

export interface AbletonTemplates {
  liveSet: string;
  midiTrack: string;
  audioTrack: string;
  sampler: string;
}

// A WAV file in the project folder
export interface AbletonSample {
  // Its path in the project folder: Samples/Imported/<name>.wav
  path: string;
  frames: number;
  sampleRate: number;
  bytes: number;
}

// One of a Sampler's sounds: played at its own pitch by `root`, and re-pitched
// by the other keys from `low` to `high`
export interface AbletonZone {
  name: string;
  sample: AbletonSample;
  root: number;
  low: number;
  high: number;
  // Its level, 0 to 1
  volume: number;
}

// Times and lengths in beats
export interface AbletonNote {
  key: number;
  time: number;
  duration: number;
  velocity: number;
}

export type AbletonTrack =
  | {
      kind: 'midi';
      name: string;
      color: number;
      // Switched on (else muted)
      on: boolean;
      notes: AbletonNote[];
      zones: AbletonZone[];
      // How long a sound rings on once its note is let go (ms)
      release: number;
    }
  | {
      kind: 'audio';
      name: string;
      color: number;
      on: boolean;
      sample: AbletonSample;
      // Its level, 0 to 1
      volume: number;
      // The tempo it was recorded at, so Live plays it in time at the song's
      bpm: number;
    };

export interface AbletonSong {
  bpm: number;
  // The song's length: its clips and its loop
  beats: number;
  tracks: AbletonTrack[];
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const number = (value: number) => String(Math.round(value * 1e6) / 1e6);

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    if (!(key in values)) throw new Error(`The Ableton template needs ${match}`);
    return values[key];
  });
}

// Every automation and modulation target and pointee a set holds has its own
// id, below the set's NextPointeeId. The tracks' are numbered from above every
// id the set template has.
const FIRST_POINTEE_ID = 100000;
class PointeeIds {
  constructor(public next: number) {}
  renumber(xml: string): string {
    return xml.replace(/<(\w*Targets?(?:\.\d+)?|Pointee) Id="\d+"/g, (_, tag: string) => `<${tag} Id="${this.next++}"`);
  }
}

function fileRef(sample: AbletonSample, id?: number): string {
  return `<FileRef${id === undefined ? '' : ` Id="${id}"`}>
<RelativePathType Value="1" />
<RelativePath Value="${escape(sample.path)}" />
<Path Value="${escape(sample.path)}" />
<Type Value="1" />
<LivePackName Value="" />
<LivePackId Value="" />
<OriginalFileSize Value="${sample.bytes}" />
<OriginalCrc Value="0" />
<SourceHint Value="" />
</FileRef>`;
}

function sampleRef(sample: AbletonSample): string {
  return `<SampleRef>
${fileRef(sample)}
<LastModDate Value="0" />
<SourceContext />
<SampleUsageHint Value="0" />
<DefaultDuration Value="${sample.frames}" />
<DefaultSampleRate Value="${sample.sampleRate}" />
<SamplesToAutoWarp Value="0" />
</SampleRef>`;
}

const timeSignature = `<TimeSignature>
<TimeSignatures>
<RemoteableTimeSignature Id="0">
<Numerator Value="4" />
<Denominator Value="4" />
<Time Value="0" />
</RemoteableTimeSignature>
</TimeSignatures>
</TimeSignature>`;

const range = (min: number, max: number) =>
  `<Min Value="${min}" />
<Max Value="${max}" />
<CrossfadeMin Value="${min}" />
<CrossfadeMax Value="${max}" />`;

function zone(part: AbletonZone, id: number): string {
  const end = part.sample.frames;
  const loop = (mode: number) => `<Start Value="0" />
<End Value="${end}" />
<Mode Value="${mode}" />
<Crossfade Value="0" />
<Detune Value="0" />`;
  return `<MultiSamplePart Id="${id}" InitUpdateAreSlicesFromOnsetsEditableAfterRead="false" HasImportedSlicePoints="false" NeedsAnalysisData="false">
<LomId Value="0" />
<Name Value="${escape(part.name)}" />
<Selection Value="${id === 0}" />
<IsActive Value="true" />
<Solo Value="false" />
<KeyRange>
${range(part.low, part.high)}
</KeyRange>
<VelocityRange>
${range(1, 127)}
</VelocityRange>
<SelectorRange>
${range(0, 127)}
</SelectorRange>
<RootKey Value="${part.root}" />
<Detune Value="0" />
<TuneScale Value="100" />
<Panorama Value="0" />
<Volume Value="${number(part.volume)}" />
<Link Value="false" />
<SampleStart Value="0" />
<SampleEnd Value="${end}" />
<SustainLoop>
${loop(0)}
</SustainLoop>
<ReleaseLoop>
${loop(3)}
</ReleaseLoop>
${sampleRef(part.sample)}
<SlicingThreshold Value="100" />
<SlicingBeatGrid Value="4" />
<SlicingRegions Value="8" />
<SlicingStyle Value="0" />
<SampleWarpProperties>
<WarpMarkers>
<WarpMarker Id="0" SecTime="0" BeatTime="0" />
<WarpMarker Id="1" SecTime="0.015625" BeatTime="0.03125" />
</WarpMarkers>
<WarpMode Value="0" />
<GranularityTones Value="30" />
<GranularityTexture Value="65" />
<FluctuationTexture Value="25" />
<ComplexProFormants Value="100" />
<ComplexProEnvelope Value="128" />
<TransientResolution Value="6" />
<TransientLoopMode Value="2" />
<TransientEnvelope Value="100" />
<IsWarped Value="false" />
<Onsets>
<UserOnsets />
<HasUserOnsets Value="false" />
</Onsets>
${timeSignature}
<BeatGrid>
<FixedNumerator Value="1" />
<FixedDenominator Value="16" />
<GridIntervalPixel Value="20" />
<Ntoles Value="2" />
<SnapToGrid Value="true" />
<Fixed Value="false" />
</BeatGrid>
</SampleWarpProperties>
<InitialSlicePointsFromOnsets />
<SlicePoints />
<ManualSlicePoints />
<BeatSlicePoints />
<RegionSlicePoints />
<UseDynamicBeatSlices Value="true" />
<UseDynamicRegionSlices Value="true" />
<AreSlicesFromOnsetsEditable Value="true" />
</MultiSamplePart>`;
}

// What every clip starts with: where it sits, its loop (off) and its name
function clipHead(tag: 'MidiClip' | 'AudioClip', name: string, color: number, end: number, warped: boolean): string {
  return `<${tag} Id="0" Time="0">
<LomId Value="0" />
<LomIdView Value="0" />
<CurrentStart Value="0" />
<CurrentEnd Value="${number(end)}" />
<Loop>
<LoopStart Value="0" />
<LoopEnd Value="${number(end)}" />
<StartRelative Value="0" />
<LoopOn Value="false" />
<OutMarker Value="${number(end)}" />
<HiddenLoopStart Value="0" />
<HiddenLoopEnd Value="${number(end)}" />
</Loop>
<Name Value="${escape(name)}" />
<Annotation Value="" />
<Color Value="${color}" />
<LaunchMode Value="0" />
<LaunchQuantisation Value="0" />
${timeSignature}
<Envelopes>
<Envelopes />
</Envelopes>
<ScrollerTimePreserver>
<LeftTime Value="0" />
<RightTime Value="${number(end)}" />
</ScrollerTimePreserver>
<TimeSelection>
<AnchorTime Value="0" />
<OtherTime Value="0" />
</TimeSelection>
<Legato Value="false" />
<Ram Value="false" />
<GrooveSettings>
<GrooveId Value="-1" />
</GrooveSettings>
<Disabled Value="false" />
<VelocityAmount Value="0" />
<FollowAction>
<FollowTime Value="4" />
<IsLinked Value="true" />
<LoopIterations Value="1" />
<FollowActionA Value="4" />
<FollowActionB Value="0" />
<FollowChanceA Value="100" />
<FollowChanceB Value="0" />
<JumpIndexA Value="1" />
<JumpIndexB Value="1" />
<FollowActionEnabled Value="false" />
</FollowAction>
<Grid>
<FixedNumerator Value="1" />
<FixedDenominator Value="16" />
<GridIntervalPixel Value="20" />
<Ntoles Value="2" />
<SnapToGrid Value="true" />
<Fixed Value="false" />
</Grid>
<FreezeStart Value="0" />
<FreezeEnd Value="0" />
<IsWarped Value="${warped}" />
<TakeId Value="0" />
<IsInKey Value="false" />
<ScaleInformation>
<Root Value="0" />
<Name Value="0" />
</ScaleInformation>`;
}

function midiClip(name: string, color: number, beats: number, notes: AbletonNote[]): string {
  const keys = [...new Set(notes.map((note) => note.key))].sort((a, b) => a - b);
  let noteId = 1;
  const keyTracks = keys
    .map((key, index) => {
      const events = notes
        .filter((note) => note.key === key)
        .sort((a, b) => a.time - b.time)
        .map(
          (note) =>
            `<MidiNoteEvent Time="${number(note.time)}" Duration="${number(note.duration)}" Velocity="${Math.round(note.velocity)}" OffVelocity="64" NoteId="${noteId++}" />`
        )
        .join('\n');
      return `<KeyTrack Id="${index}">
<Notes>
${events}
</Notes>
<MidiKey Value="${key}" />
</KeyTrack>`;
    })
    .join('\n');
  return `${clipHead('MidiClip', name, color, beats, true)}
<AutomationEnvelopesListWrapper LomId="0" />
<Notes>
<KeyTracks>
${keyTracks}
</KeyTracks>
<PerNoteEventStore>
<EventLists />
</PerNoteEventStore>
<NoteProbabilityGroups />
<ProbabilityGroupIdGenerator>
<NextId Value="1" />
</ProbabilityGroupIdGenerator>
<NoteIdGenerator>
<NextId Value="${noteId}" />
</NoteIdGenerator>
</Notes>
<BankSelectCoarse Value="-1" />
<BankSelectFine Value="-1" />
<ProgramChange Value="-1" />
<NoteEditorFoldInZoom Value="-1" />
<NoteEditorFoldInScroll Value="0" />
<NoteEditorFoldOutZoom Value="-1" />
<NoteEditorFoldOutScroll Value="0" />
<NoteEditorFoldScaleZoom Value="-1" />
<NoteEditorFoldScaleScroll Value="0" />
<NoteSpellingPreference Value="0" />
<AccidentalSpellingPreference Value="3" />
<PreferFlatRootNote Value="false" />
<ExpressionGrid>
<FixedNumerator Value="1" />
<FixedDenominator Value="16" />
<GridIntervalPixel Value="20" />
<Ntoles Value="2" />
<SnapToGrid Value="false" />
<Fixed Value="false" />
</ExpressionGrid>
</MidiClip>`;
}

// A recording, warped from its own tempo to the song's: Live keeps it in time
// at whatever tempo the set plays
function audioClip(name: string, color: number, sample: AbletonSample, bpm: number, volume: number): string {
  const seconds = sample.frames / sample.sampleRate;
  const beats = (seconds * bpm) / 60;
  return `${clipHead('AudioClip', name, color, beats, true)}
<AutomationEnvelopesListWrapper LomId="0" />
${sampleRef(sample)}
<Onsets>
<UserOnsets />
<HasUserOnsets Value="false" />
</Onsets>
<WarpMode Value="4" />
<GranularityTones Value="30" />
<GranularityTexture Value="65" />
<FluctuationTexture Value="25" />
<TransientResolution Value="6" />
<TransientLoopMode Value="2" />
<TransientEnvelope Value="100" />
<ComplexProFormants Value="100" />
<ComplexProEnvelope Value="128" />
<Sync Value="true" />
<HiQ Value="true" />
<Fade Value="false" />
<Fades>
<FadeInLength Value="0" />
<FadeOutLength Value="0" />
<ClipFadesAreInitialized Value="true" />
<CrossfadeInState Value="0" />
<FadeInCurveSkew Value="0" />
<FadeInCurveSlope Value="0" />
<FadeOutCurveSkew Value="0" />
<FadeOutCurveSlope Value="0" />
<IsDefaultFadeIn Value="false" />
<IsDefaultFadeOut Value="false" />
</Fades>
<PitchCoarse Value="0" />
<PitchFine Value="0" />
<SampleVolume Value="${number(volume)}" />
<WarpMarkers>
<WarpMarker Id="0" SecTime="0" BeatTime="0" />
<WarpMarker Id="1" SecTime="${number(seconds)}" BeatTime="${number(beats)}" />
</WarpMarkers>
<SavedWarpMarkersForStretched />
<MarkersGenerated Value="false" />
<IsSongTempoLeader Value="false" />
</AudioClip>`;
}

export function abletonLiveSet(song: AbletonSong, templates: AbletonTemplates): string {
  const ids = new PointeeIds(FIRST_POINTEE_ID);
  const tracks = song.tracks
    .map((track, index) => {
      const common = { ID: String(index), NAME: escape(track.name), COLOR: String(track.color), ON: String(track.on) };
      if (track.kind === 'audio')
        return ids.renumber(fill(templates.audioTrack, { ...common, CLIPS: audioClip(track.name, track.color, track.sample, track.bpm, track.volume) }));
      const sampler = fill(templates.sampler, {
        NAME: escape(track.name),
        RELEASE_MS: number(track.release),
        ZONES: track.zones.map(zone).join('\n'),
      });
      return ids.renumber(
        fill(templates.midiTrack, {
          ...common,
          CLIPS: midiClip(track.name, track.color, song.beats, track.notes),
          DEVICES: sampler,
        })
      );
    })
    .join('\n');
  return fill(templates.liveSet, {
    TRACKS: tracks,
    BPM: number(song.bpm),
    BEATS: number(song.beats),
    NEXT_ID: String(ids.next),
  });
}
