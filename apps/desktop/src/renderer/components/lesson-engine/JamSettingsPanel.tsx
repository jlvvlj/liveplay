import { useState, type ReactNode } from 'react';
import type { Lesson, LessonScore } from '../../types/lesson';
import { BackIcon, SYNTH_TAG_ICONS, SidebarIcon } from './JamIcons';
import { CategoryArt } from './instruments/CategoryArt';
import type { JamRoomPlayer } from './jamRoom';
import { JAM_ROOM_NAME_MAX } from './jamRoomProtocol';
import { JAM_DAW_MAX_BPM, JAM_DAW_MIN_BPM } from './jamTracks';
import type { HighwayMode } from './NoteHighway';

const LESSON_MODES: { mode: HighwayMode; label: string }[] = [
  { mode: 'free', label: 'Free' },
  { mode: 'wait', label: 'Wait' },
  { mode: 'play', label: 'Play' },
  { mode: 'jam', label: 'Jam' },
];

interface JamSettingsPanelProps {
  // The Daw has only the backing track's settings and the room; the played
  // notes' settings are the Jam's
  section?: 'daw' | 'jam';
  songs: Lesson[];
  songId: string;
  onSongChange: (id: string) => void;
  // Playing together online: the room this player is in (a private room's
  // code, null for an open room) and its players once joined
  room?: { code: string | null; joined: boolean; players: JamRoomPlayer[] };
  // A lesson room's lesson, with lesson mode's settings: this player's
  // score, the lanes to practise and how loud its notes play by themselves
  // (0: they don't)
  lesson?: {
    score: LessonScore;
    lanes: ReactNode;
    autoPlay: number;
    onAutoPlayChange: (volume: number) => void;
    // This player's mode: lesson mode's Free, Wait and Play, or Jam (on the
    // room's clock); `game` while a game started with Start runs
    mode: HighwayMode;
    game: boolean;
    onModeChange: (mode: HighwayMode) => void;
    // The room's tempo on the Jam tab; null when its song keeps its own (an
    // imported song's recordings)
    tempo: number | null;
    onTempoChange: (bpm: number) => void;
    // Play mode's speed, 0 to 2
    speed: number;
    onSpeedChange: (speed: number) => void;
    metronome: number;
    onMetronomeChange: (volume: number) => void;
    // Jam: the room's pause; Play: this player's
    paused: boolean;
    onTogglePause: () => void;
    onRestart: () => void;
    onStartGame: () => void;
  };
  // This player's name on their ship in rooms; empty for the room's numbered name
  roomName?: string;
  onRoomNameChange?: (name: string) => void;
  view: 'highway' | 'grid';
  // Switches between the highway and the backing track's grid; none when the
  // song's backing track has no grid
  onViewChange?: (view: 'highway' | 'grid') => void;
  // The instrument played: its name, category and preset (a synth's preset
  // shown by its kind of sound); it opens the instruments panel
  instrument: { name: string; category: string; preset: string; tag?: string; art: number } | null;
  onOpenInstruments: () => void;
  holdDivisions: number[];
  holdDivision: number;
  onHoldDivisionChange: (division: number) => void;
  holdTriplet: boolean;
  onHoldTripletChange: (triplet: boolean) => void;
  // Played notes' swing: the share of each beat its first 8th takes
  swing: number;
  onSwingChange: (swing: number) => void;
  notesVolume: number;
  onNotesVolumeChange: (volume: number) => void;
  backingVolume: number;
  onBackingVolumeChange: (volume: number) => void;
  title: string;
  bpm: number;
  midiActive: boolean;
  lastMidiNote: number | null;
  showKeys: boolean;
  onToggleKeys: () => void;
  labelMode: 'letters' | 'numbers';
  onLabelModeChange: (mode: 'letters' | 'numbers') => void;
  // Leaves the Jam; none in the standalone jam app
  onBack?: () => void;
  onClose: () => void;
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="jam-slider">
      <div className="jam-slider-head">
        <span>{label}</span>
        <span className="jam-slider-value">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="volume-slider"
      />
    </div>
  );
}

// The room's tempo: its value follows the slider while it moves, and the room
// changes tempo once it is let go (each change renders the track again)
function TempoSlider({ tempo, onChange }: { tempo: number; onChange: (bpm: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? tempo;
  const commit = () => {
    if (draft !== null && draft !== tempo) onChange(draft);
    setDraft(null);
  };
  return (
    <div className="jam-slider">
      <div className="jam-slider-head">
        <span>Tempo</span>
        <span className="jam-slider-value">{shown} BPM</span>
      </div>
      <input
        type="range"
        min={JAM_DAW_MIN_BPM}
        max={JAM_DAW_MAX_BPM}
        step={1}
        value={shown}
        aria-label="Tempo"
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="volume-slider"
      />
    </div>
  );
}

export function JamSettingsPanel({
  section,
  songs,
  songId,
  onSongChange,
  room,
  lesson,
  roomName = '',
  onRoomNameChange,
  view,
  onViewChange,
  instrument,
  onOpenInstruments,
  holdDivisions,
  holdDivision,
  onHoldDivisionChange,
  holdTriplet,
  onHoldTripletChange,
  swing,
  onSwingChange,
  notesVolume,
  onNotesVolumeChange,
  backingVolume,
  onBackingVolumeChange,
  title,
  bpm,
  midiActive,
  lastMidiNote,
  showKeys,
  onToggleKeys,
  labelMode,
  onLabelModeChange,
  onBack,
  onClose,
}: JamSettingsPanelProps) {
  const playing = section !== 'daw';
  const [linkCopied, setLinkCopied] = useState(false);

  return (
    <div className="game-settings-sidebar">
      <div className="game-settings-header jam-settings-header">
        {onBack && (
          <button className="jam-corner-btn jam-back-btn" onClick={onBack} title="Back">
            <BackIcon />
          </button>
        )}
        <div className="jam-song">
          <span className="jam-song-title">{title}</span>
          <span className="toolbar-badge">{bpm} BPM</span>
        </div>
        <button className="jam-corner-btn on" onClick={onClose} title="Hide sidebar">
          <SidebarIcon />
        </button>
      </div>

      <div className="game-settings-content">
        {(songs.length > 1 || onViewChange) && (
          <div className="setting-group">
            <label className="setting-label">
              <span className="setting-icon">&#127926;</span>
              Track
              {onViewChange && (
                <span className="jam-feel-switch">
                  {(['highway', 'grid'] as const).map((option) => (
                    <button
                      key={option}
                      className={option === view ? 'active' : ''}
                      onClick={() => onViewChange(option)}
                    >
                      {option === 'highway' ? 'Highway' : 'Grid'}
                    </button>
                  ))}
                </span>
              )}
            </label>
            {songs.length > 1 && (
              <div className="jam-sound-grid">
                {songs.map((song) => (
                  <button
                    key={song.id}
                    className={`jam-sound-option ${song.id === songId ? 'active' : ''}`}
                    onClick={() => onSongChange(song.id)}
                  >
                    {song.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="setting-group">
          <label className="setting-label">
            <span className="setting-icon">&#128266;</span>
            Volume
          </label>
          {playing && (
            <Slider
              label="Notes"
              value={notesVolume}
              display={`${Math.round(notesVolume * 100)}%`}
              min={0}
              max={1}
              step={0.05}
              onChange={onNotesVolumeChange}
            />
          )}
          <Slider
            label="Backing track"
            value={backingVolume}
            display={`${Math.round(backingVolume * 100)}%`}
            min={0}
            max={1}
            step={0.05}
            onChange={onBackingVolumeChange}
          />
        </div>

        {lesson && (
          <div className="setting-group">
            <label className="setting-label">
              <span className="setting-icon">&#127919;</span>
              Lesson
              <span className="setting-value">{lesson.score.accuracy.toFixed(1)}%</span>
            </label>
            <div className="jam-lesson-score">
              <span>
                <b>{lesson.score.perfectHits}</b> perfect
              </span>
              <span>
                <b>{lesson.score.hits}</b> hits
              </span>
              <span>
                <b>{lesson.score.misses}</b> missed
              </span>
            </div>
            <div className="jam-sound-options jam-hold-options jam-lesson-modes">
              {LESSON_MODES.map(({ mode, label }) => (
                <button
                  key={mode}
                  className={`jam-sound-option ${mode === lesson.mode && !lesson.game ? 'active' : ''}`}
                  onClick={() => lesson.onModeChange(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="jam-sound-options jam-hold-options jam-lesson-controls">
              {(lesson.mode === 'jam' || lesson.mode === 'play') && (
                <button className="jam-sound-option" onClick={lesson.onTogglePause}>
                  {lesson.paused ? '\u25B6 Play' : '\u275A\u275A Pause'}
                </button>
              )}
              <button className="jam-sound-option" onClick={lesson.onRestart}>
                &#8635; Restart
              </button>
              <button className={`jam-sound-option ${lesson.game ? 'active' : ''}`} onClick={lesson.onStartGame}>
                Start
              </button>
            </div>
            {lesson.mode === 'jam' && lesson.tempo !== null && <TempoSlider tempo={lesson.tempo} onChange={lesson.onTempoChange} />}
            {lesson.mode === 'play' && !lesson.game && (
              <Slider
                label="Speed"
                value={lesson.speed}
                display={`${Math.round(lesson.speed * 100)}%`}
                min={0}
                max={2}
                step={0.05}
                onChange={lesson.onSpeedChange}
              />
            )}
            {/* The beat and the steps playing by themselves need a clock: not in Free and Wait */}
            {(lesson.mode === 'jam' || lesson.mode === 'play') && (
              <>
                <Slider
                  label="Metronome"
                  value={lesson.metronome}
                  display={lesson.metronome === 0 ? 'Off' : `${Math.round(lesson.metronome * 100)}%`}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={lesson.onMetronomeChange}
                />
                <Slider
                  label="Auto-play"
                  value={lesson.autoPlay}
                  display={lesson.autoPlay === 0 ? 'Off' : `${Math.round(lesson.autoPlay * 100)}%`}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={lesson.onAutoPlayChange}
                />
              </>
            )}
            <div className="jam-subhead">Sounds</div>
            {lesson.lanes}
          </div>
        )}

        {/* Hold repeat plays on the room's clock: in a lesson room, on the Jam tab */}
        {playing && (!lesson || lesson.mode === 'jam') && (
        <div className="setting-group">
          <label className="setting-label">
            <span className="setting-icon">&#128257;</span>
            Hold repeat
            <span className="jam-feel-switch">
              {[false, true].map((triplet) => (
                <button
                  key={String(triplet)}
                  className={triplet === holdTriplet ? 'active' : ''}
                  onClick={() => onHoldTripletChange(triplet)}
                >
                  {triplet ? 'Triplet' : 'Straight'}
                </button>
              ))}
            </span>
          </label>
          <div className="jam-sound-options jam-hold-options">
            {holdDivisions.map((division) => (
              <button
                key={division}
                className={`jam-sound-option ${division === holdDivision ? 'active' : ''}`}
                onClick={() => onHoldDivisionChange(division)}
              >
                {division}
                {holdTriplet ? 'T' : ''}
              </button>
            ))}
          </div>
          <Slider
            label="Swing"
            value={swing}
            display={swing <= 0.5 ? 'Straight' : `${Math.round(swing * 100)}%`}
            min={0.5}
            max={0.75}
            step={0.01}
            onChange={onSwingChange}
          />
        </div>
        )}

        {room && (
          <div className="setting-group">
            <label className="setting-label">
              <span className="setting-icon">&#127760;</span>
              Together
            </label>
            <div className="jam-room-code">
              <span className={room.code ? undefined : 'jam-room-open'}>{room.code ?? 'Open'}</span>
              {navigator.clipboard && (
                <button
                  className="jam-sound-option"
                  onClick={() =>
                    navigator.clipboard.writeText(location.href).then(() => {
                      setLinkCopied(true);
                      setTimeout(() => setLinkCopied(false), 1500);
                    })
                  }
                >
                  {linkCopied ? 'Copied' : 'Copy link'}
                </button>
              )}
            </div>
            {room.joined && (
              <div className="jam-room-players">
                {room.players.map((player) =>
                  player.you ? (
                    <label key={player.id} className="jam-room-player jam-room-you">
                      <span className="jam-room-dot" style={{ background: player.color }} />
                      <input
                        className="jam-room-name"
                        value={roomName}
                        placeholder={player.name}
                        maxLength={JAM_ROOM_NAME_MAX}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => onRoomNameChange?.(event.target.value)}
                      />
                    </label>
                  ) : (
                    <span key={player.id} className="jam-room-player" title={player.direct ? 'Direct' : 'Through the server'}>
                      <span className="jam-room-dot" style={{ background: player.color }} />
                      {player.name}
                      <span className="jam-room-latency">
                        {player.latency === null ? '…' : `${Math.round(player.latency * 1000)} ms`}
                      </span>
                    </span>
                  )
                )}
              </div>
            )}
          </div>
        )}

        {playing && (
        <>
        <div className="setting-group">
          <label className="setting-label">
            <span className="setting-icon">&#127929;</span>
            Keys
          </label>
          <div className="jam-keys-row">
            <div className={`toolbar-midi ${midiActive ? 'active' : ''}`} title="MIDI Status">
              <span className="midi-dot"></span>
              {lastMidiNote !== null ? lastMidiNote : 'MIDI'}
            </div>
            <button className={`toolbar-btn ${showKeys ? 'active' : ''}`} onClick={onToggleKeys} title="Key Bindings">
              Keys
            </button>
            <div className="toolbar-label-tabs">
              <button
                className={`toolbar-label-tab ${labelMode === 'letters' ? 'active' : ''}`}
                onClick={() => onLabelModeChange('letters')}
              >
                ABC
              </button>
              <button
                className={`toolbar-label-tab ${labelMode === 'numbers' ? 'active' : ''}`}
                onClick={() => onLabelModeChange('numbers')}
              >
                123
              </button>
            </div>
          </div>
        </div>

        {/* A lesson room's hits play its lesson track's own sound */}
        {!lesson && (
        <div className="setting-group">
          <label className="setting-label">
            <span className="setting-icon">&#127927;</span>
            Instrument
          </label>
          {instrument && (
            <button className="jam-instrument-current" onClick={onOpenInstruments}>
              <span className="instrument-detail-art">
                {instrument.tag ? (
                  <span className="instrument-card-icon">{SYNTH_TAG_ICONS[instrument.tag]?.()}</span>
                ) : (
                  <CategoryArt seed={instrument.art} />
                )}
              </span>
              <span className="instrument-detail-title">
                <span className="instrument-card-name">{instrument.tag ? instrument.preset : instrument.name}</span>
                <span className="instrument-card-detail">{instrument.tag ? instrument.name : `${instrument.category} · ${instrument.preset}`}</span>
              </span>
            </button>
          )}
        </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}
