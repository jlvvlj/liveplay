import { useState } from 'react';
import * as Tone from 'tone';
import { newJamRoomCode, type JamRoomEnd } from './jamRoom';
import {
  JAM_ROOM_CODE,
  JAM_ROOM_MAX_PLAYERS,
  type JamRoomSummary,
  type JamRoomVisibility,
} from './jamRoomProtocol';
import { BackIcon } from './JamIcons';
import { jamBpmLabel } from './jamTracks';
import { JamDropdown, type JamDropdownGroup } from './JamDropdown';
import { jamLessonName, type JamLessonChoice } from './jamLessonRooms';
import './JamLobby.css';

// The jam app's Jam section: every live room as a card, open rooms joined
// with a click and private ones with their code, and a card to open a new
// room on the track its opener picks.

export interface JamRoomEntry {
  key: string;
  create?: { visibility: JamRoomVisibility; song: string; lesson?: string[] };
  // Into a lesson room: the tracks this player learns there
  tracks?: string[];
}

// A track a new room can play: a built-in song, or a Daw song offered to
// rooms, with its own tracks (a lesson room's lesson is one or more of them)
export interface JamLobbyTrack {
  id: string;
  title: string;
  bpm: number;
  daw: boolean;
  tracks: JamLessonChoice[];
}

interface JamLobbyProps {
  // The live rooms (null until the server first answers), whether the
  // server cannot be reached right now, and a check of a private room's code
  rooms: JamRoomSummary[] | null;
  unreachable: boolean;
  check: (id: string, code: string) => Promise<boolean | null>;
  tracks: JamLobbyTrack[];
  onEnter: (entry: JamRoomEntry) => void;
  onBack: () => void;
  // Why the player is back here, when the room ended by itself
  ended?: JamRoomEnd | null;
  // The Lessons section: its rooms are lesson rooms, each opened with a lesson track
  lessons?: boolean;
  // A lesson room whose card opens to pick tracks (its key)
  pick?: string;
}

const ENDED: Record<JamRoomEnd, string> = {
  full: 'That room is full',
  missing: 'That room has ended',
  lost: 'The connection to the room was lost',
  song: "That room's song could not be loaded",
  taken: 'Someone else took those tracks first',
};

// A song's lesson tracks as the dropdown lists them: a kit's drums under its
// name, then the other tracks. A track another player has is shown, dim, with
// their name.
function lessonTrackGroups(choices: JamLessonChoice[], holders: Map<string, string> = new Map()): JamDropdownGroup[] {
  const groups = choices.reduce<(JamDropdownGroup & { kit?: string })[]>((made, track) => {
    const last = made[made.length - 1];
    const holder = holders.get(track.id);
    const option = { value: track.id, label: track.name, ...(holder !== undefined ? { detail: holder, disabled: true } : {}) };
    if (last && last.kit === track.kit) last.options.push(option);
    else made.push({ kit: track.kit, label: track.kit, options: [option] });
    return made;
  }, []);
  if (groups.some((group) => group.kit !== undefined)) for (const group of groups) if (group.kit === undefined) group.label = 'Tracks';
  return groups.map(({ label, options }) => ({ ...(label !== undefined ? { label } : {}), options }));
}

// Browsers (Safari above all) only start audio within a tap or click, and the
// room's Jam opens after it: the click that leads into a room starts it
export function startJamAudio() {
  const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (audioSession) audioSession.type = 'playback'; // iPhone: play through the silent switch
  Tone.start().catch((err) => console.error('[JamLobby] Could not start the audio:', err));
}

const LockIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2.2" />
  </svg>
);

export function JamLobby({ rooms, unreachable, check, tracks, onEnter: enterRoom, onBack, ended, lessons = false, pick }: JamLobbyProps) {
  const onEnter = (entry: JamRoomEntry) => {
    startJamAudio();
    enterRoom(entry);
  };
  return (
    <div className="jam-lobby">
      <JamLobbyHeader title={lessons ? 'Lessons' : 'Jam'} onBack={onBack} />
      {/* Without the server the rooms are unknown and none can be opened or
          joined: only that is shown until it is back */}
      {unreachable ? (
        <div className="jam-lobby-note">Can&apos;t reach the rooms. Trying again…</div>
      ) : (
        <>
          {ended && <div className="jam-lobby-note">{ENDED[ended]}</div>}
          {rooms && (
            <div className="jam-lobby-grid">
              <NewRoomCard tracks={tracks} lessons={lessons} onCreate={(create) => onEnter({ key: newJamRoomCode(), create })} />
              {rooms
                .filter((room) => (room.lesson !== null) === lessons)
                .map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  onEnter={onEnter}
                  check={(code) => check(room.id, code)}
                  picking={!!pick && room.key === pick}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// A section's header: back to the jam app's home, and the section's name
export function JamLobbyHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="jam-lobby-header">
      <button className="jam-corner-btn jam-back-btn" onClick={onBack} title="Back">
        <BackIcon />
      </button>
      <h1>{title}</h1>
    </header>
  );
}

// The card that opens a new room: its track first (the room plays it for as
// long as it lasts), for a lesson room then which of its tracks to learn (any
// of them together: a kit's drums are listed each on its own, under the kit),
// then open to everyone or private with a code
function NewRoomCard({
  tracks,
  lessons,
  onCreate,
}: {
  tracks: JamLobbyTrack[];
  lessons: boolean;
  onCreate: (create: { visibility: JamRoomVisibility; song: string; lesson?: string[] }) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [song, setSong] = useState('');
  const [lesson, setLesson] = useState<string[]>([]);
  if (!choosing) {
    return (
      <button className="jam-lobby-card jam-lobby-new" onClick={() => setChoosing(true)}>
        <span className="jam-lobby-plus">+</span>
        New room
      </button>
    );
  }
  const options = (daw: boolean) =>
    tracks.filter((track) => track.daw === daw).map((track) => ({ value: track.id, label: track.title, detail: jamBpmLabel(track.bpm) }));
  const groups = [
    { label: 'Songs', options: options(false) },
    { label: 'Daw', options: options(true) },
  ].filter((group) => group.options.length);
  const lessonTracks = tracks.find((track) => track.id === song)?.tracks ?? [];
  const lessonGroups = lessonTrackGroups(lessonTracks);
  const ready = song && (!lessons || lesson.length > 0);
  const create = (visibility: JamRoomVisibility) => onCreate({ visibility, song, ...(lessons ? { lesson } : {}) });
  return (
    <div className="jam-lobby-card jam-lobby-new jam-lobby-choosing">
      <div className="jam-lobby-card-head">New room</div>
      <JamDropdown
        groups={groups}
        value={song}
        onChange={(next) => {
          setSong(next);
          setLesson([]);
        }}
        placeholder="Track"
        autoFocus
      />
      {lessons && song && (
        <JamDropdown
          multiple
          groups={lessonGroups}
          value={lesson}
          onChange={setLesson}
          summary={(picked) => jamLessonName(lessonTracks, picked)}
          placeholder="Lesson tracks"
        />
      )}
      {ready && (
        <div className="jam-lobby-choices">
          <button className="jam-lobby-choice" onClick={() => create('open')}>
            Open
          </button>
          <button className="jam-lobby-choice" onClick={() => create('private')}>
            <LockIcon />
            Private
          </button>
        </div>
      )}
      <button
        className="jam-lobby-cancel"
        onClick={() => {
          setChoosing(false);
          setSong('');
          setLesson([]);
        }}
        title="Cancel"
      >
        &times;
      </button>
    </div>
  );
}

interface RoomCardProps {
  room: JamRoomSummary;
  onEnter: (entry: JamRoomEntry) => void;
  check: (code: string) => Promise<boolean | null>;
  // Opens straight to picking tracks (a lesson room's link without them)
  picking?: boolean;
}

// A live room: its song and players. An open Jam room is joined with a click;
// a private room asks for its code on the card first, and a lesson room for
// the tracks to learn there, from those no one else has.
function RoomCard({ room, onEnter, check, picking = false }: RoomCardProps) {
  const [asking, setAsking] = useState(picking);
  const [code, setCode] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // A lesson room's tracks: whose each one is, and those still free
  const lesson = room.lesson;
  const holders = new Map(
    (lesson?.players ?? []).flatMap((holder) => {
      const name = room.players.find((player) => player.id === holder.id)?.name ?? '';
      return holder.tracks.map((track) => [track, name] as const);
    })
  );
  const free = (lesson?.choices ?? []).filter((choice) => !holders.has(choice.id));
  const tracks = picked.filter((id) => free.some((choice) => choice.id === id));
  const full = room.full || (!!lesson && free.length === 0);

  const body = (
    <>
      <div className="jam-lobby-card-top">
        <span className={`jam-lobby-badge ${room.visibility}`}>
          {room.visibility === 'private' && <LockIcon />}
          {room.visibility === 'open' ? 'Open' : 'Private'}
        </span>
        <span className="jam-lobby-count">{full ? 'Full' : `${room.players.length}/${JAM_ROOM_MAX_PLAYERS}`}</span>
      </div>
      <div className="jam-lobby-title">{room.host}&apos;s room</div>
      <div className="jam-lobby-song">
        {room.playing && <span className="jam-lobby-live" />}
        {lesson?.name ? `${lesson.name} · ${room.song.title}` : room.song.title}
        <span className="jam-lobby-bpm">{jamBpmLabel(room.song.bpm)}</span>
      </div>
      <div className="jam-lobby-players">
        {room.players.map((player, index) => (
          <span key={index} className="jam-lobby-player">
            <span className="jam-lobby-dot" style={{ background: player.color }} />
            {player.name}
          </span>
        ))}
      </div>
    </>
  );

  if (!asking || full) {
    return (
      <button
        className="jam-lobby-card"
        disabled={full}
        onClick={() => (room.visibility === 'open' && room.key && !lesson ? onEnter({ key: room.key }) : setAsking(true))}
      >
        {body}
      </button>
    );
  }

  const coded = room.visibility === 'open' || JAM_ROOM_CODE.test(code);
  const ready = coded && (!lesson || tracks.length > 0) && !checking;
  const submit = async () => {
    if (!ready) return;
    const entry = (key: string): JamRoomEntry => ({ key, ...(lesson ? { tracks } : {}) });
    if (room.visibility === 'open' && room.key) {
      onEnter(entry(room.key));
      return;
    }
    startJamAudio(); // now, while this is still the player's click
    setChecking(true);
    const ok = await check(code);
    setChecking(false);
    if (ok) onEnter(entry(code));
    else setProblem(ok === false ? 'Wrong code' : "Can't reach the rooms");
  };

  return (
    <div className="jam-lobby-card jam-lobby-asking">
      {body}
      {lesson && (
        <JamDropdown
          multiple
          groups={lessonTrackGroups(lesson.choices, holders)}
          value={tracks}
          onChange={setPicked}
          summary={(ids) => jamLessonName(lesson.choices, ids)}
          placeholder="Your tracks"
          autoFocus={room.visibility === 'open'}
        />
      )}
      <form
        className="jam-lobby-code"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {room.visibility === 'private' && (
          <input
            className={problem ? 'wrong' : undefined}
            value={code}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
              setProblem(null);
            }}
            placeholder="Code"
            maxLength={8}
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <button type="submit" disabled={!ready}>
          Join
        </button>
        <button
          type="button"
          className="jam-lobby-cancel"
          onClick={() => {
            setAsking(false);
            setPicked([]);
          }}
          title="Cancel"
        >
          &times;
        </button>
      </form>
      {problem && <div className="jam-lobby-problem">{problem}</div>}
    </div>
  );
}
