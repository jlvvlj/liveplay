import { useState, type ReactNode } from 'react';
import type { Lesson, LessonScore } from '../../types/lesson';
import { BackIcon, CheckIcon, LinkIcon, PauseIcon, PlayIcon, RestartIcon, SYNTH_TAG_ICONS, SidebarIcon } from './JamIcons';
import { CategoryArt } from './instruments/CategoryArt';
import type { JamRoomPlayer } from './jamRoom';
import { JAM_ROOM_NAME_MAX } from './jamRoomProtocol';
import { jamBpmLabel } from './jamTracks';
import type { HighwayMode } from './NoteHighway';

const LESSON_MODES: { mode: HighwayMode; label: string }[] = [
  { mode: 'free', label: 'Free' },
  { mode: 'wait', label: 'Wait' },
  { mode: 'play', label: 'Play' },
  { mode: 'jam', label: 'Jam' },
];

interface JamSettingsPanelProps {
  // The instruments being chosen (for the played sound or a track): their
  // own section of the sidebar, after its settings
  instruments?: ReactNode;
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
    // How far through the lesson this pass is, in Free and Wait (they don't judge timing)
    played: number;
    steps: number;
    lanes: ReactNode;
    autoPlay: number;
    onAutoPlayChange: (volume: number) => void;
    // This player's mode: lesson mode's Free, Wait and Play, or Jam (on the
    // room's clock); `game` while a game started with Start runs
    mode: HighwayMode;
    game: boolean;
    onModeChange: (mode: HighwayMode) => void;
    // The room's tempo on the Jam tab, and how far it goes
    tempo: number | null;
    tempoRange: [number, number];
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
  // None: no repeat
  holdDivision: number | null;
  onHoldDivisionChange: (division: number | null) => void;
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

// A section of the sidebar: its title, and a control beside it
function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="setting-group jam-side-section">
      <div className="jam-side-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

// One choice of a few, as pills in a track; clicking the chosen one again
// lets it go when `clearable`
function Segmented<T extends string | number | boolean>({
  options,
  value,
  onChange,
  small,
  clearable,
}: {
  options: { value: T; label: ReactNode }[];
  value: T | null;
  onChange: (value: T | null) => void;
  small?: boolean;
  clearable?: boolean;
}) {
  return (
    <div className={`jam-segmented ${small ? 'small' : ''}`}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(clearable && option.value === value ? null : option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// A player's initials, for their avatar
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

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
function TempoSlider({ tempo, range, onChange }: { tempo: number; range: [number, number]; onChange: (bpm: number) => void }) {
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
        min={range[0]}
        max={range[1]}
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
  instruments,
}: JamSettingsPanelProps) {
  const playing = section !== 'daw';
  const [linkCopied, setLinkCopied] = useState(false);

  return (
    <div className="game-settings-sidebar jam-sidebar">
      <div className="game-settings-header jam-settings-header">
        {onBack && (
          <button className="jam-corner-btn jam-back-btn" onClick={onBack} title="Back">
            <BackIcon />
          </button>
        )}
        <div className="jam-song">
          <span className="jam-song-title">{title}</span>
          <span className="toolbar-badge">{jamBpmLabel(bpm)}</span>
        </div>
        <button className="jam-corner-btn on" onClick={onClose} title="Hide sidebar">
          <SidebarIcon />
        </button>
      </div>

      <div className="game-settings-content">
        {(songs.length > 1 || onViewChange) && (
          <Section
            title="Track"
            aside={
              onViewChange && (
                <Segmented
                  small
                  options={[
                    { value: 'highway' as const, label: 'Highway' },
                    { value: 'grid' as const, label: 'Grid' },
                  ]}
                  value={view}
                  onChange={(option) => option && onViewChange(option)}
                />
              )
            }
          >
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
          </Section>
        )}

        <Section title="Volume">
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
        </Section>

        {lesson && (
          <Section
            title="Lesson"
            aside={lesson.mode === 'free' || lesson.mode === 'wait' ? undefined : <span className="jam-side-value">{lesson.score.accuracy.toFixed(1)}%</span>}
          >
            {lesson.mode === 'free' || lesson.mode === 'wait' ? (
              <div className="jam-lesson-score">
                <span>
                  <b>{lesson.played}</b> of {lesson.steps} played
                </span>
              </div>
            ) : (
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
            )}
            <Segmented
              options={LESSON_MODES.map(({ mode, label }) => ({ value: mode, label }))}
              value={lesson.game ? null : lesson.mode}
              onChange={(mode) => mode && lesson.onModeChange(mode)}
            />
            <div className="jam-side-buttons">
              {(lesson.mode === 'jam' || lesson.mode === 'play') && (
                <button className="jam-pill-btn" onClick={lesson.onTogglePause}>
                  {lesson.paused ? <PlayIcon /> : <PauseIcon />}
                  {lesson.paused ? 'Play' : 'Pause'}
                </button>
              )}
              <button className="jam-pill-btn" onClick={lesson.onRestart}>
                <RestartIcon />
                Restart
              </button>
              <button className={`jam-pill-btn primary ${lesson.game ? 'active' : ''}`} onClick={lesson.onStartGame}>
                Start
              </button>
            </div>
            {lesson.mode === 'jam' && lesson.tempo !== null && <TempoSlider tempo={lesson.tempo} range={lesson.tempoRange} onChange={lesson.onTempoChange} />}
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
          </Section>
        )}

        {/* Hold repeat plays on the room's clock: in a lesson room, on the Jam tab */}
        {playing && (!lesson || lesson.mode === 'jam') && (
        <Section
          title="Hold repeat"
          aside={
            <Segmented
              small
              options={[
                { value: false, label: 'Straight' },
                { value: true, label: 'Triplet' },
              ]}
              value={holdTriplet}
              onChange={(triplet) => triplet !== null && onHoldTripletChange(triplet)}
            />
          }
        >
          <Segmented
            clearable
            options={holdDivisions.map((division) => ({ value: division, label: `${division}${holdTriplet ? 'T' : ''}` }))}
            value={holdDivision}
            onChange={onHoldDivisionChange}
          />
          <Slider
            label="Swing"
            value={swing}
            display={swing <= 0.5 ? 'Straight' : `${Math.round(swing * 100)}%`}
            min={0.5}
            max={0.75}
            step={0.01}
            onChange={onSwingChange}
          />
        </Section>
        )}

        {room && (
          <Section
            title="Together"
            aside={
              navigator.clipboard && (
                <button
                  className="jam-pill-btn small"
                  onClick={() =>
                    navigator.clipboard.writeText(location.href).then(() => {
                      setLinkCopied(true);
                      setTimeout(() => setLinkCopied(false), 1500);
                    })
                  }
                >
                  {linkCopied ? <CheckIcon /> : <LinkIcon />}
                  {linkCopied ? 'Copied' : 'Copy link'}
                </button>
              )
            }
          >
            <div className="jam-room-code">
              {room.code ? <span className="jam-room-key">{room.code}</span> : <span className="jam-room-open">Open room</span>}
            </div>
            {room.joined && (
              <div className="jam-room-players">
                {room.players.map((player) =>
                  player.you ? (
                    <label key={player.id} className="jam-room-player jam-room-you">
                      <span className="jam-room-avatar" style={{ background: player.color }}>
                        {initials(roomName || player.name)}
                      </span>
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
                      <span className="jam-room-avatar" style={{ background: player.color }}>
                        {initials(player.name)}
                      </span>
                      <span className="jam-room-player-name">{player.name}</span>
                      <span className="jam-room-latency">
                        {player.latency === null ? '…' : `${Math.round(player.latency * 1000)} ms`}
                      </span>
                    </span>
                  )
                )}
              </div>
            )}
          </Section>
        )}

        {playing && (
        <>
        <Section
          title="Keys"
          aside={
            <span className={`jam-midi-status ${midiActive ? 'active' : ''}`} title="MIDI">
              <i />
              {lastMidiNote !== null ? lastMidiNote : 'MIDI'}
            </span>
          }
        >
          <div className="jam-keys-row">
            <button className={`jam-pill-btn ${showKeys ? 'active' : ''}`} onClick={onToggleKeys} title="Key bindings">
              Show keys
            </button>
            <Segmented
              small
              options={[
                { value: 'letters' as const, label: 'ABC' },
                { value: 'numbers' as const, label: '123' },
              ]}
              value={labelMode}
              onChange={(mode) => mode && onLabelModeChange(mode)}
            />
          </div>
        </Section>

        {/* A lesson room's hits play its lesson track's own sound; with the
            instruments shown below, they say what plays */}
        {!lesson && !instruments && (
        <Section title="Instrument">
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
        </Section>
        )}
        </>
        )}
        {instruments && <section className="setting-group jam-side-section jam-side-instruments">{instruments}</section>}
      </div>
    </div>
  );
}
