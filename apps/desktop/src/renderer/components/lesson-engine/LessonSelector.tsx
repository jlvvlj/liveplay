import { useState, useEffect, useRef } from 'react';
import { Lesson } from '../../types/lesson';
import { Song, StemName, STEM_NAMES, STEM_LABELS } from '../../types/song';
import { midiToLesson, loadMidiFile } from '../../utils/midiToLesson';
import { stemLessonFromSong, StemLessonData } from '../../utils/stemLessonFromSong';
import {
  AbletonProject,
  AbletonTrack,
  abletonTrackToLesson,
  findSampleFile,
  isPlayable,
  lessonStartBeat,
  readAbletonProject,
  renderBacking,
  withSoundLengths,
} from '../../utils/abletonImport';
import {
  SavedProject,
  allowReading,
  canRememberFolders,
  detectAudioTrack,
  listSavedProjects,
  pickAndSaveProject,
  readFolder,
  removeSavedProject,
} from '../../utils/abletonLibrary';
import './LessonSelector.css';

interface LessonSelectorProps {
  onLessonSelect: (lesson: Lesson) => void;
  onSongSelect: (song: Song) => void;
  onSongEdit: (song: Song) => void;
  onSongInstrumentEdit: (song: Song) => void;
}

interface MidiFileInfo {
  filename: string;
  name: string;
}

// Built-in sample lessons for pads/drums practice
const SAMPLE_LESSONS: Lesson[] = [
  {
    id: 'basic-pad-01',
    title: 'Basic 4/4 Pad Groove',
    instrument: 'pads',
    bpm: 80,
    timeSignature: {
      numerator: 4,
      denominator: 4,
    },
    steps: [
      { tick: 1440, note: 41, dur: 120, velocity: 100, lane: 3 },
      { tick: 1920, note: 36, dur: 120, velocity: 100, lane: 0 },
      { tick: 2400, note: 38, dur: 120, velocity: 100, lane: 1 },
      { tick: 2880, note: 40, dur: 120, velocity: 90, lane: 2 },
      { tick: 3360, note: 41, dur: 120, velocity: 90, lane: 3 },
      { tick: 5360, note: 41, dur: 120, velocity: 90, lane: 3 },
      { tick: 7440, note: 41, dur: 120, velocity: 100, lane: 3 },
      { tick: 8920, note: 36, dur: 120, velocity: 100, lane: 0 },
      { tick: 9400, note: 38, dur: 120, velocity: 100, lane: 1 },
      { tick: 12880, note: 40, dur: 120, velocity: 90, lane: 2 },
      { tick: 15604, note: 41, dur: 120, velocity: 90, lane: 3 },
      { tick: 19360, note: 41, dur: 120, velocity: 90, lane: 3 },
    ],
    loop: {
      startTick: 0,
      endTick: 19360,
    },
    metadata: {
      difficulty: 1,
      genre: 'Practice',
      tags: ['beginner', 'pads', '4/4'],
      description: 'Learn the basic four-pad pattern in 4/4 time',
    },
  },
  {
    id: 'basic-keys-01',
    title: 'C Major Scale Practice',
    instrument: 'keys',
    bpm: 80,
    timeSignature: {
      numerator: 4,
      denominator: 4,
    },
    steps: [
      { tick: 0, note: 60, dur: 480, velocity: 100 },
      { tick: 480, note: 62, dur: 480, velocity: 100 },
      { tick: 960, note: 64, dur: 480, velocity: 100 },
      { tick: 1440, note: 65, dur: 480, velocity: 100 },
      { tick: 1920, note: 67, dur: 480, velocity: 100 },
      { tick: 2400, note: 69, dur: 480, velocity: 100 },
      { tick: 2880, note: 71, dur: 480, velocity: 100 },
      { tick: 3360, note: 72, dur: 480, velocity: 100 },
    ],
    loop: {
      startTick: 0,
      endTick: 3840,
    },
    metadata: {
      difficulty: 1,
      genre: 'Practice',
      tags: ['beginner', 'keys', 'scales', 'C major'],
      description: 'Practice the C major scale from middle C to high C',
    },
  },
  {
    id: 'samples-16-31',
    title: '16 Sample Sequence',
    instrument: 'pads',
    bpm: 80,
    timeSignature: {
      numerator: 4,
      denominator: 4,
    },
    steps: [
      { tick: 0, note: 36, dur: 120, velocity: 100, lane: 0 },
      { tick: 480, note: 37, dur: 120, velocity: 100, lane: 1 },
      { tick: 960, note: 38, dur: 120, velocity: 100, lane: 2 },
      { tick: 1440, note: 39, dur: 120, velocity: 100, lane: 3 },
      { tick: 1920, note: 40, dur: 120, velocity: 100, lane: 4 },
      { tick: 2400, note: 41, dur: 120, velocity: 100, lane: 5 },
      { tick: 2880, note: 42, dur: 120, velocity: 100, lane: 6 },
      { tick: 3360, note: 43, dur: 120, velocity: 100, lane: 7 },
      { tick: 3840, note: 44, dur: 120, velocity: 100, lane: 8 },
      { tick: 4320, note: 45, dur: 120, velocity: 100, lane: 9 },
      { tick: 4800, note: 46, dur: 120, velocity: 100, lane: 10 },
      { tick: 5280, note: 47, dur: 120, velocity: 100, lane: 11 },
      { tick: 5760, note: 48, dur: 120, velocity: 100, lane: 12 },
      { tick: 6240, note: 49, dur: 120, velocity: 100, lane: 13 },
      { tick: 6720, note: 50, dur: 120, velocity: 100, lane: 14 },
      { tick: 7200, note: 51, dur: 120, velocity: 100, lane: 15 },
    ],
    loop: {
      startTick: 0,
      endTick: 7680,
    },
    samples: {
      36: 'sample-16.wav',
      37: 'sample-17.wav',
      38: 'sample-18.wav',
      39: 'sample-19.wav',
      40: 'sample-20.wav',
      41: 'sample-21.wav',
      42: 'sample-22.wav',
      43: 'sample-23.wav',
      44: 'sample-24.wav',
      45: 'sample-25.wav',
      46: 'sample-26.wav',
      47: 'sample-27.wav',
      48: 'sample-28.wav',
      49: 'sample-29.wav',
      50: 'sample-30.wav',
      51: 'sample-31.wav',
    },
    metadata: {
      difficulty: 2,
      genre: 'Practice',
      tags: ['samples', 'pads', '16-notes'],
      description: 'Practice all 16 audio samples in sequence',
    },
  },
  {
    id: 'song-1-practice',
    title: 'Song 1 - Practice with Backing Track',
    instrument: 'pads',
    bpm: 120,
    timeSignature: {
      numerator: 4,
      denominator: 4,
    },
    steps: [
      // Intro - single notes to warm up (first 4 bars)
      { tick: 480, note: 60, dur: 240, velocity: 100, lane: 0 },
      { tick: 1440, note: 61, dur: 240, velocity: 100, lane: 1 },
      { tick: 2400, note: 62, dur: 240, velocity: 100, lane: 2 },
      { tick: 3360, note: 60, dur: 240, velocity: 100, lane: 0 },
      // Build up - alternating pattern (bars 5-8)
      { tick: 3840, note: 60, dur: 240, velocity: 100, lane: 0 },
      { tick: 4320, note: 61, dur: 240, velocity: 100, lane: 1 },
      { tick: 4800, note: 60, dur: 240, velocity: 100, lane: 0 },
      { tick: 5280, note: 62, dur: 240, velocity: 100, lane: 2 },
      { tick: 5760, note: 61, dur: 240, velocity: 100, lane: 1 },
      { tick: 6240, note: 60, dur: 240, velocity: 100, lane: 0 },
      { tick: 6720, note: 62, dur: 240, velocity: 100, lane: 2 },
      { tick: 7200, note: 61, dur: 240, velocity: 100, lane: 1 },
      // Main section - faster pattern (bars 9-12)
      { tick: 7680, note: 60, dur: 120, velocity: 110, lane: 0 },
      { tick: 7920, note: 61, dur: 120, velocity: 100, lane: 1 },
      { tick: 8160, note: 62, dur: 120, velocity: 100, lane: 2 },
      { tick: 8400, note: 61, dur: 120, velocity: 100, lane: 1 },
      { tick: 8640, note: 60, dur: 120, velocity: 110, lane: 0 },
      { tick: 8880, note: 62, dur: 120, velocity: 100, lane: 2 },
      { tick: 9120, note: 61, dur: 120, velocity: 100, lane: 1 },
      { tick: 9360, note: 60, dur: 120, velocity: 100, lane: 0 },
      { tick: 9600, note: 62, dur: 240, velocity: 110, lane: 2 },
      { tick: 10080, note: 60, dur: 240, velocity: 100, lane: 0 },
      { tick: 10560, note: 61, dur: 240, velocity: 100, lane: 1 },
      { tick: 11040, note: 62, dur: 240, velocity: 100, lane: 2 },
      // Outro - slower finish (bars 13-16)
      { tick: 11520, note: 60, dur: 480, velocity: 90, lane: 0 },
      { tick: 12480, note: 61, dur: 480, velocity: 90, lane: 1 },
      { tick: 13440, note: 62, dur: 480, velocity: 90, lane: 2 },
      { tick: 14400, note: 60, dur: 960, velocity: 80, lane: 0 },
    ],
    loop: {
      startTick: 0,
      endTick: 15360, // 16 bars at 120 BPM
    },
    samples: {
      60: 'samples/song_1/song_1_note_1.wav',
      61: 'samples/song_1/song_2_note_2.wav',
      62: 'samples/song_1/song_3_note_3.wav',
    },
    backingTrack: 'samples/song_1/song_1_backingtrack.wav',
    metadata: {
      difficulty: 2,
      genre: 'Practice',
      tags: ['backing-track', 'pads', 'song'],
      description: 'Practice playing along with a backing track using 3 samples',
    },
  },
];

export function LessonSelector({ onLessonSelect, onSongSelect, onSongEdit, onSongInstrumentEdit }: LessonSelectorProps) {
  const [lessons] = useState<Lesson[]>(SAMPLE_LESSONS);
  const [midiFiles, setMidiFiles] = useState<MidiFileInfo[]>([]);
  const [loadingMidi, setLoadingMidi] = useState<string | null>(null);
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);
  const [activeTab, setActiveTab] = useState<'practice' | 'piano' | 'songs'>('piano');
  const [songs, setSongs] = useState<Song[]>([]);
  const [uploading, setUploading] = useState(false);
  const [songsError, setSongsError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ableton projects are read in the browser from their folder. Where the
  // browser can remember folders (Chrome, Edge) each project gets its own
  // card that survives reloads; elsewhere a picked folder lasts until reload.
  const UNSAVED = 'unsaved';
  const abletonInputRef = useRef<HTMLInputElement>(null);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [openProjects, setOpenProjects] = useState<Record<string, AbletonProject>>({});
  const [abletonBusy, setAbletonBusy] = useState<string | null>(null); // project id being read
  const [abletonErrors, setAbletonErrors] = useState<Record<string, string>>({});
  const [abletonPreparing, setAbletonPreparing] = useState<string | null>(null); // `${projectId}:${track}`
  useEffect(() => {
    // folder picking isn't a typed React prop
    abletonInputRef.current?.setAttribute('webkitdirectory', '');
  });

  const setAbletonError = (id: string, message: string | null) =>
    setAbletonErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const readProject = async (id: string, read: () => Promise<AbletonProject>) => {
    setAbletonBusy(id);
    setAbletonError(id, null);
    try {
      const project = await read();
      setOpenProjects((prev) => ({ ...prev, [id]: project }));
    } catch (error) {
      setAbletonError(id, error instanceof Error ? error.message : String(error));
    } finally {
      setAbletonBusy(null);
    }
  };

  // Re-read from disk on every open, so new exports are picked up.
  const openSavedProject = (saved: SavedProject) =>
    readProject(saved.id, async () => {
      await allowReading(saved);
      return readAbletonProject(await readFolder(saved.handle));
    });

  // Remembered projects come back after a reload. Those the browser still
  // lets us read open straight away; the others open on click.
  useEffect(() => {
    if (!canRememberFolders()) return;
    listSavedProjects()
      .then(async (saved) => {
        setSavedProjects(saved);
        for (const project of saved) {
          const handle = project.handle as unknown as { queryPermission(d: { mode: 'read' }): Promise<PermissionState> };
          if ((await handle.queryPermission({ mode: 'read' })) === 'granted') openSavedProject(project);
        }
      })
      .catch((error) => setAbletonError(UNSAVED, `Could not load saved projects: ${error}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenAbleton = async () => {
    if (abletonBusy) return;
    if (!canRememberFolders()) {
      abletonInputRef.current?.click();
      return;
    }
    try {
      const saved = await pickAndSaveProject();
      if (!saved) return; // picker dismissed
      setSavedProjects(await listSavedProjects());
      await openSavedProject(saved);
    } catch (error) {
      setAbletonError(UNSAVED, error instanceof Error ? error.message : String(error));
    }
  };

  const handleRemoveProject = async (saved: SavedProject) => {
    await removeSavedProject(saved.id);
    setSavedProjects((prev) => prev.filter((p) => p.id !== saved.id));
    setOpenProjects((prev) => {
      const next = { ...prev };
      delete next[saved.id];
      return next;
    });
  };

  const playAbletonTrack = async (
    projectId: string,
    project: AbletonProject,
    name: string,
    getTrack: () => AbletonTrack | Promise<AbletonTrack>
  ) => {
    setAbletonPreparing(`${projectId}:${name}`);
    setAbletonError(projectId, null);
    try {
      const track = await getTrack();
      const exported = project.exports.get(track.name);
      const sample = exported ? null : findSampleFile(project, track);
      const backing = await renderBacking(project, track, (lessonStartBeat(track) * 60) / project.tempo);
      const lesson = abletonTrackToLesson(project, track, {
        export: exported ? URL.createObjectURL(exported) : undefined,
        sample: sample ? URL.createObjectURL(sample) : undefined,
        backing: backing ?? undefined,
      });
      // with an export, each note's real sound length is known: long sounds
      // become hold notes
      onLessonSelect(exported ? await withSoundLengths(lesson, exported) : lesson);
    } catch (error) {
      setAbletonError(projectId, `Could not prepare ${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAbletonPreparing(null);
    }
  };

  const renderAbletonTracks = (projectId: string, project: AbletonProject) => (
    <>
      <p className="lesson-description">
        {project.name} · {project.tempo} BPM ·{' '}
        {project.exports.size > 0
          ? `${project.exports.size} exported tracks (real sound + backing)`
          : 'no exported tracks: sample tracks only, no backing'}
      </p>
      <div className="song-card-actions">
        {project.tracks
          .filter((track) => isPlayable(project, track))
          .map((track) => (
            <button
              key={track.name}
              className="song-action-button song-stem-lesson-button"
              disabled={abletonPreparing !== null}
              onClick={(e) => {
                e.stopPropagation(); // a track button opens the lesson, not the card
                playAbletonTrack(projectId, project, track.name, () => track);
              }}
              title={`${track.notes.length} notes`}
            >
              {abletonPreparing === `${projectId}:${track.name}` ? 'Preparing…' : track.name}
            </button>
          ))}
      </div>
      {project.audioTracks.some((name) => project.exports.has(name)) && (
        <>
          <p className="lesson-description">Audio tracks · hits detected from the export</p>
          <div className="song-card-actions">
            {project.audioTracks
              .filter((name) => project.exports.has(name))
              .map((name) => (
                <button
                  key={name}
                  className="song-action-button song-stem-lesson-button"
                  disabled={abletonPreparing !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    playAbletonTrack(projectId, project, name, () => detectAudioTrack(project, name));
                  }}
                  title="Detects the hits in this track's export (a few seconds the first time)"
                >
                  {abletonPreparing === `${projectId}:${name}` ? 'Analyzing…' : name}
                </button>
              ))}
          </div>
        </>
      )}
    </>
  );

  const fetchSongs = async () => {
    try {
      const response = await fetch('/api/songs');
      if (!response.ok) throw new Error(`API error ${response.status}`);
      setSongs(await response.json());
      setSongsError(null);
    } catch (error) {
      setSongsError('Songs API unreachable — is the server running? (npm run dev:server)');
    }
  };

  // Load songs on mount and when the tab is opened, then poll while any job is active
  useEffect(() => {
    if (activeTab === 'songs') fetchSongs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    fetchSongs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasActiveJob = songs.some((s) => s.status === 'queued' || s.status === 'separating');
  useEffect(() => {
    if (!hasActiveJob) return;
    const interval = setInterval(fetchSongs, 1500);
    return () => clearInterval(interval);
  }, [hasActiveJob]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const response = await fetch(`/api/songs?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/mpeg' },
        body: file,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `Upload failed (${response.status})` }));
        throw new Error(body.error);
      }
      const song: Song = await response.json();
      await fetch(`/api/songs/${song.id}/separate`, { method: 'POST' });
      await fetchSongs();
    } catch (error) {
      setSongsError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };

  const [analyzing, setAnalyzing] = useState<string | null>(null); // `${songId}:${stem}`

  const handleStemLesson = async (song: Song, stem: StemName) => {
    setAnalyzing(`${song.id}:${stem}`);
    try {
      const response = await fetch(`/api/songs/${song.id}/stem-lesson?stem=${stem}`, {
        method: 'POST',
      });
      const data: StemLessonData | { error: string } = await response.json();
      if (!response.ok || 'error' in data) {
        throw new Error('error' in data ? data.error : `Analysis failed (${response.status})`);
      }
      onLessonSelect(stemLessonFromSong(song, data));
    } catch (error) {
      setSongsError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalyzing(null);
    }
  };

  const handleRetry = async (song: Song) => {
    await fetch(`/api/songs/${song.id}/separate`, { method: 'POST' });
    await fetchSongs();
  };

  const handleDelete = async (song: Song) => {
    await fetch(`/api/songs/${song.id}`, { method: 'DELETE' });
    await fetchSongs();
  };

  // Fetch available MIDI files on mount
  useEffect(() => {
    async function fetchMidiFiles() {
      try {
        const response = await fetch('/api/pieces');
        if (response.ok) {
          const files: MidiFileInfo[] = await response.json();
          setMidiFiles(files);
        }
      } catch (error) {
        console.error('Failed to fetch MIDI files:', error);
      }
    }
    fetchMidiFiles();
  }, []);

  const handleSelectMidiFile = async (file: MidiFileInfo) => {
    setLoadingMidi(file.filename);
    try {
      const midiUrl = `/pieces/midi/${encodeURIComponent(file.filename)}`;
      const midiData = await loadMidiFile(midiUrl);
      const lesson = await midiToLesson(midiData, file.filename, {
        simplifyToMelody: true,
        maxNotes: 5000,
      });
      setSelectedLesson(lesson);
      onLessonSelect(lesson);
    } catch (error) {
      console.error('Failed to load MIDI file:', error);
    } finally {
      setLoadingMidi(null);
    }
  };

  const handleSelectLesson = (lesson: Lesson) => {
    setSelectedLesson(lesson);
    onLessonSelect(lesson);
  };

  const getDifficultyStars = (difficulty: number): string => {
    return '★'.repeat(difficulty) + '☆'.repeat(Math.max(0, 5 - difficulty));
  };

  return (
    <div className="lesson-selector">
      <h2>Choose a Lesson</h2>

      <div className="lesson-tabs">
        <button
          className={`tab-button ${activeTab === 'piano' ? 'active' : ''}`}
          onClick={() => setActiveTab('piano')}
        >
          Piano Pieces ({midiFiles.length})
        </button>
        <button
          className={`tab-button ${activeTab === 'practice' ? 'active' : ''}`}
          onClick={() => setActiveTab('practice')}
        >
          Practice Lessons ({lessons.length})
        </button>
        <button
          className={`tab-button ${activeTab === 'songs' ? 'active' : ''}`}
          onClick={() => setActiveTab('songs')}
        >
          Songs ({songs.length})
        </button>
      </div>

      {activeTab === 'piano' && (
        <div className="lesson-grid midi-grid">
          {midiFiles.length === 0 ? (
            <div className="empty-state">
              <p>No MIDI files found in pieces/midi folder</p>
            </div>
          ) : (
            midiFiles.map((file) => (
              <div
                key={file.filename}
                className={`lesson-card piano-card ${loadingMidi === file.filename ? 'loading' : ''}`}
                onClick={() => handleSelectMidiFile(file)}
              >
                <div className="lesson-card-header">
                  <h3>{file.name}</h3>
                  <span className="instrument-tag keys">piano</span>
                </div>
                <div className="lesson-card-body">
                  <p className="lesson-description">
                    {loadingMidi === file.filename ? 'Loading...' : 'Click to load piano lesson'}
                  </p>
                  <div className="lesson-tags">
                    <span className="tag">midi</span>
                    <span className="tag">piano</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'songs' && (
        <div className="lesson-grid songs-grid">
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,audio/mpeg"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUpload(file);
              e.target.value = '';
            }}
          />
          <div
            className={`lesson-card import-card ${uploading ? 'loading' : ''}`}
            onClick={() => !uploading && fileInputRef.current?.click()}
          >
            <div className="lesson-card-header">
              <h3>{uploading ? 'Uploading…' : '+ Import song (MP3)'}</h3>
            </div>
            <div className="lesson-card-body">
              <p className="lesson-description">
                Upload a track to split it into drums, bass, vocals and other stems you can
                practice along with.
              </p>
            </div>
          </div>

          <input
            ref={abletonInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []).map((file) => ({ path: file.webkitRelativePath, file }));
              if (files.length > 0) readProject(UNSAVED, () => readAbletonProject(files));
              e.target.value = '';
            }}
          />
          <div
            className={`lesson-card import-card ${abletonBusy === UNSAVED ? 'loading' : ''}`}
            onClick={handleOpenAbleton}
            title="Choose an Ableton project folder"
          >
            <div className="lesson-card-header">
              <h3>{abletonBusy === UNSAVED ? 'Reading project…' : '+ Open Ableton project'}</h3>
            </div>
            <div className="lesson-card-body">
              {!openProjects[UNSAVED] && (
                <p className="lesson-description">
                  Choose an Ableton project folder, then pick a track to play its notes.
                  {canRememberFolders()
                    ? ' The project stays here after a reload.'
                    : ' This browser cannot remember the folder: pick it again after a reload.'}
                </p>
              )}
              {abletonErrors[UNSAVED] && <p className="lesson-description song-error-text">{abletonErrors[UNSAVED]}</p>}
              {openProjects[UNSAVED] && renderAbletonTracks(UNSAVED, openProjects[UNSAVED])}
            </div>
          </div>

          {savedProjects.map((saved) => {
            const project = openProjects[saved.id];
            return (
              <div
                key={saved.id}
                className={`lesson-card song-card ${abletonBusy === saved.id ? 'loading' : ''}`}
                onClick={() => !project && abletonBusy === null && openSavedProject(saved)}
              >
                <div className="lesson-card-header">
                  <h3>{saved.name}</h3>
                  <span className="instrument-tag pads">ableton</span>
                </div>
                <div className="lesson-card-body">
                  {!project && (
                    <p className="lesson-description">
                      {abletonBusy === saved.id ? 'Reading project…' : 'Click to open this project'}
                    </p>
                  )}
                  {abletonErrors[saved.id] && (
                    <p className="lesson-description song-error-text">{abletonErrors[saved.id]}</p>
                  )}
                  {project && renderAbletonTracks(saved.id, project)}
                  <div className="song-card-actions">
                    {project && (
                      <button
                        className="song-action-button"
                        disabled={abletonBusy !== null}
                        title="Read the folder again, e.g. after a new export"
                        onClick={(e) => {
                          e.stopPropagation();
                          openSavedProject(saved);
                        }}
                      >
                        ↻ Reload
                      </button>
                    )}
                    <button
                      className="song-action-button song-delete-button"
                      title="Forget this project (the folder itself is not touched)"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveProject(saved);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {songsError && <div className="songs-error">{songsError}</div>}

          {songs.map((song) => (
            <div
              key={song.id}
              className={`lesson-card song-card song-${song.status}`}
              onClick={() => song.status === 'ready' && onSongSelect(song)}
            >
              <div className="lesson-card-header">
                <h3>{song.title}</h3>
                <span className="instrument-tag pads">song</span>
              </div>
              <div className="lesson-card-body">
                {(song.status === 'queued' || song.status === 'separating') && (
                  <div className="song-progress">
                    <p className="lesson-description">
                      {song.progress?.stage === 'provisioning'
                        ? 'Preparing separation environment…'
                        : song.progress?.stage === 'separating'
                          ? `Separating stems… ${Math.round((song.progress?.progress ?? 0) * 100)}%`
                          : song.progress?.stage === 'exporting'
                            ? 'Exporting stems…'
                            : song.status === 'queued'
                              ? 'Waiting in queue…'
                              : 'Loading model…'}
                    </p>
                    <div className="song-progress-bar">
                      <div
                        className="song-progress-fill"
                        style={{ width: `${Math.round((song.progress?.progress ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
                {song.status === 'ready' && (
                  <p className="lesson-description">
                    Ready to practice
                    {song.duration
                      ? ` — ${Math.floor(song.duration / 60)}:${String(Math.round(song.duration % 60)).padStart(2, '0')}`
                      : ''}
                  </p>
                )}
                {song.status === 'error' && (
                  <p className="lesson-description song-error-text" title={song.error ?? undefined}>
                    Separation failed: {song.error?.split('\n')[0] ?? 'unknown error'}
                  </p>
                )}
                {song.status === 'imported' && (
                  <p className="lesson-description">Imported — not separated yet</p>
                )}
                <div className="song-card-actions">
                  <button
                    className="song-action-button"
                    title="Open the separate synth reconstruction editor and practice mode"
                    onClick={(e) => { e.stopPropagation(); onSongInstrumentEdit(song); }}
                  >
                    Instrument Lab editor
                  </button>
                  {song.status === 'ready' &&
                    STEM_NAMES.map((stem) => (
                      <button
                        key={stem}
                        className="song-action-button song-stem-lesson-button"
                        disabled={analyzing !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStemLesson(song, stem);
                        }}
                      >
                        {analyzing === `${song.id}:${stem}` ? 'Analyzing…' : STEM_LABELS[stem]}
                      </button>
                    ))}
                  {song.status === 'ready' && (
                    <button
                      className="song-action-button"
                      title="Correct the detected sounds and timings"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSongEdit(song);
                      }}
                    >
                      ✎ Edit sounds
                    </button>
                  )}
                  {(song.status === 'error' || song.status === 'imported') && (
                    <button
                      className="song-action-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRetry(song);
                      }}
                    >
                      {song.status === 'error' ? 'Retry' : 'Separate'}
                    </button>
                  )}
                  {song.status !== 'separating' && (
                    <button
                      className="song-action-button song-delete-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(song);
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'practice' && (
        <div className="lesson-grid">
          {lessons.map((lesson) => (
            <div
              key={lesson.id}
              className={`lesson-card ${selectedLesson?.id === lesson.id ? 'selected' : ''}`}
              onClick={() => handleSelectLesson(lesson)}
            >
              <div className="lesson-card-header">
                <h3>{lesson.title}</h3>
                <span className={`instrument-tag ${lesson.instrument}`}>
                  {lesson.instrument}
                </span>
              </div>
              <div className="lesson-card-body">
                <p className="lesson-description">{lesson.metadata?.description}</p>
                <div className="lesson-stats">
                  <div className="stat">
                    <span className="stat-icon">♪</span>
                    <span>{lesson.bpm} BPM</span>
                  </div>
                  <div className="stat">
                    <span className="stat-icon">📊</span>
                    <span>{lesson.steps.length} Steps</span>
                  </div>
                  {lesson.metadata?.difficulty && (
                    <div className="stat">
                      <span className="difficulty-stars">
                        {getDifficultyStars(lesson.metadata.difficulty)}
                      </span>
                    </div>
                  )}
                </div>
                {lesson.metadata?.tags && (
                  <div className="lesson-tags">
                    {lesson.metadata.tags.map((tag) => (
                      <span key={tag} className="tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
