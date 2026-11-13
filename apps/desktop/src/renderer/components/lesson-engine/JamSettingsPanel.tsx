import { useMemo, useState, type ReactNode } from 'react';
import type { Lesson, LessonScore } from '../../types/lesson';
import { CalendarIcon, CheckIcon, CloseIcon, ExportIcon, LinkIcon, MailIcon, SendIcon, ShareIcon, PauseIcon, PlayIcon, RestartIcon, SYNTH_TAG_ICONS } from './JamIcons';
import { CategoryArt } from './instruments/CategoryArt';
import type { JamRoomPlayer } from './jamRoom';
import { JAM_ROOM_NAME_MAX } from './jamRoomProtocol';
import { JamDropdown } from './JamDropdown';
import { setKnownEmail, useKnownPlayers, type JamKnownPlayer } from './jamPlayer';
import { SESSION_LENGTHS, SESSION_TIMES, googleCalendarUrl, icsFile, nextHalfHour, sessionDays, type JamSession } from './jamCalendar';
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
  room?: {
    code: string | null;
    joined: boolean;
    players: JamRoomPlayer[];
    // Invites players met before (by lasting id) in their app: those whose app
    // was open to take it; null when the server could not be asked
    invite?: (to: string[]) => Promise<string[] | null>;
  };
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
  onClose: () => void;
  // What it shows: the song's settings and instruments, or who plays together
  page: 'settings' | 'together';
  // Closing: the sidebar slides back under the rail, then onLeft
  leaving: boolean;
  onLeft: () => void;
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
  onClose,
  page,
  leaving,
  onLeft,
  instruments,
}: JamSettingsPanelProps) {
  const playing = section !== 'daw';

  return (
    <div
      className={`game-settings-sidebar jam-sidebar ${leaving ? 'leaving' : ''}`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && leaving) onLeft();
      }}
    >
      <div className="game-settings-header jam-settings-header">
        {page === 'together' ? (
          <div className="jam-song">
            <span className="jam-song-title">Together</span>
          </div>
        ) : (
          <div className="jam-song">
            <span className="jam-song-title">{title}</span>
            <span className="toolbar-badge">{jamBpmLabel(bpm)}</span>
          </div>
        )}
        <button className="jam-side-close" onClick={onClose} title="Close">
          <CloseIcon />
        </button>
      </div>

      {page === 'together' && room ? (
        <div className="game-settings-content" key="together">
          <TogetherPage room={room} roomName={roomName} onRoomNameChange={onRoomNameChange} songTitle={title} />
        </div>
      ) : (
      <div className="game-settings-content" key="settings">
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

        {playing && (
        <Section title="Volume">
          {(
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
          {/* The whole song: in the Daw every track, under the played notes the backing track */}
          <Slider
            label={playing ? 'Backing track' : 'Master'}
            value={backingVolume}
            display={`${Math.round(backingVolume * 100)}%`}
            min={0}
            max={1}
            step={0.05}
            onChange={onBackingVolumeChange}
          />
        </Section>
        )}

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
      )}
    </div>
  );
}

type JamRoomShown = NonNullable<JamSettingsPanelProps['room']>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dayLabel = (day: Date, i: number) =>
  i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeLabel = (minutes: number) =>
  new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const lengthLabel = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`.replace('.5 h', ' h 30'));

// The sidebar's Together page: who is in the room (your own name typed here),
// inviting players met before (in the app when it is open, or by email) or
// anyone with the link, and planning a session in a calendar
function TogetherPage({
  room,
  roomName,
  onRoomNameChange,
  songTitle,
}: {
  room: JamRoomShown;
  roomName: string;
  onRoomNameChange?: (name: string) => void;
  songTitle: string;
}) {
  const [copied, setCopied] = useState(false);
  const known = useKnownPlayers();
  // Players met before who are not here now
  const here = new Set(room.players.map((player) => player.player));
  const invitable = known.filter((player) => !here.has(player.player));
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = picked.map((id) => known.find((player) => player.player === id)).filter((player): player is JamKnownPlayer => !!player);
  // What became of each live invite: their app took it, or was not open
  const [sent, setSent] = useState<Record<string, 'invited' | 'offline'>>({});
  const [sending, setSending] = useState(false);
  const days = useMemo(() => sessionDays(), []);
  const [day, setDay] = useState(0);
  const [time, setTime] = useState(nextHalfHour);
  const [length, setLength] = useState(60);

  const link = location.href;
  const invite = `Play ${songTitle} with me`;
  const emails = chosen.map((player) => player.email.trim()).filter((email) => EMAIL.test(email));
  const session: JamSession = {
    title: invite,
    link,
    start: new Date(days[day].getFullYear(), days[day].getMonth(), days[day].getDate(), Math.floor(time / 60), time % 60),
    minutes: length,
    guests: emails,
  };

  const copy = () =>
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const share = () =>
    navigator.share({ title: invite, url: link }).catch((error: unknown) => {
      // Closing the share sheet is no failure
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    });
  const sendInvites = async () => {
    if (!room.invite) return;
    setSending(true);
    const reached = await room.invite(picked);
    setSending(false);
    if (reached === null) return;
    setSent((before) => ({ ...before, ...Object.fromEntries(picked.map((id) => [id, reached.includes(id) ? 'invited' : 'offline'])) }));
  };
  const downloadIcs = () => {
    const url = URL.createObjectURL(new Blob([icsFile(session, `${Date.now()}-${Math.random().toString(36).slice(2)}@melodics-jam`)], { type: 'text/calendar' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${songTitle}.ics`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Section title="Players" aside={room.joined && <span className="jam-side-value">{room.players.length}</span>}>
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

      <Section title="Invite">
        {invitable.length > 0 && (
          <JamDropdown
            multiple
            className="jam-invite-pick"
            placeholder="Players you've played with"
            groups={[{ options: invitable.map((player) => ({ value: player.player, label: player.name, detail: player.email })) }]}
            value={picked}
            onChange={setPicked}
            summary={(value) => (value.length === 1 ? '1 player' : `${value.length} players`)}
          />
        )}
        {chosen.length > 0 && (
          <div className="jam-invite-players">
            {chosen.map((player) => (
              <div key={player.player} className="jam-invite-player">
                <span className="jam-room-avatar" style={{ background: player.color }}>
                  {initials(player.name)}
                </span>
                <span className="jam-invite-who">
                  <span className="jam-invite-name">
                    {player.name}
                    {sent[player.player] && <span className={`jam-invite-state ${sent[player.player]}`}>{sent[player.player] === 'invited' ? 'Invited' : 'Offline'}</span>}
                  </span>
                  <input
                    className="jam-invite-email"
                    type="email"
                    value={player.email}
                    placeholder="Email"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setKnownEmail(player.player, event.target.value)}
                    aria-label={`${player.name}'s email`}
                  />
                </span>
                <button className="jam-invite-remove" onClick={() => setPicked(picked.filter((id) => id !== player.player))} title={`Remove ${player.name}`}>
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
        {chosen.length > 0 && (
          <div className="jam-side-buttons">
            {room.invite && (
              <button className="jam-pill-btn" onClick={sendInvites} disabled={sending}>
                <SendIcon />
                Invite
              </button>
            )}
            <a className="jam-pill-btn" href={`mailto:${emails.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(invite)}&body=${encodeURIComponent(link)}`}>
              <MailIcon />
              Email
            </a>
          </div>
        )}
        <div className="jam-invite-link">
          <span className="jam-invite-url" title={link}>
            {link.replace(/^https?:\/\//, '')}
          </span>
          <button className="jam-pill-btn small" onClick={copy}>
            {copied ? <CheckIcon /> : <LinkIcon />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="jam-side-buttons">
          {typeof navigator.share === 'function' && (
            <button className="jam-pill-btn" onClick={share}>
              <ShareIcon />
              Share
            </button>
          )}
          {chosen.length === 0 && (
            <a className="jam-pill-btn" href={`mailto:?subject=${encodeURIComponent(invite)}&body=${encodeURIComponent(link)}`}>
              <MailIcon />
              Email
            </a>
          )}
        </div>
      </Section>

      <Section title="Plan a session">
        <div className="jam-session-when">
          <JamDropdown
            className="jam-session-day"
            groups={[{ options: days.map((date, i) => ({ value: String(i), label: dayLabel(date, i) })) }]}
            value={String(day)}
            onChange={(value) => setDay(Number(value))}
          />
          <JamDropdown
            className="jam-session-time"
            groups={[{ options: SESSION_TIMES.map((minutes) => ({ value: String(minutes), label: timeLabel(minutes) })) }]}
            value={String(time)}
            onChange={(value) => setTime(Number(value))}
          />
          <JamDropdown
            className="jam-session-length"
            groups={[{ options: SESSION_LENGTHS.map((minutes) => ({ value: String(minutes), label: lengthLabel(minutes) })) }]}
            value={String(length)}
            onChange={(value) => setLength(Number(value))}
          />
        </div>
        <div className="jam-side-buttons jam-session-add">
          <a className="jam-pill-btn" href={googleCalendarUrl(session)} target="_blank" rel="noreferrer">
            <CalendarIcon />
            Google Calendar
          </a>
          <button className="jam-pill-btn" onClick={downloadIcs}>
            <ExportIcon />
            Other calendar
          </button>
        </div>
      </Section>
    </>
  );
}
