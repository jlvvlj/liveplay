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
import { JamDropdown } from './JamDropdown';
import './JamLobby.css';

// The jam app's Jam section: every live room as a card, open rooms joined
// with a click and private ones with their code, and a card to open a new
// room on the track its opener picks.

export interface JamRoomEntry {
  key: string;
  create?: { visibility: JamRoomVisibility; song: string };
}

// A track a new room can play: a built-in song, or a Daw song offered to rooms
export interface JamLobbyTrack {
  id: string;
  title: string;
  bpm: number;
  daw: boolean;
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
}

const ENDED: Record<JamRoomEnd, string> = {
  full: 'That room is full',
  missing: 'That room has ended',
  lost: 'The connection to the room was lost',
};

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

export function JamLobby({ rooms, unreachable, check, tracks, onEnter: enterRoom, onBack, ended }: JamLobbyProps) {
  const onEnter = (entry: JamRoomEntry) => {
    startJamAudio();
    enterRoom(entry);
  };
  return (
    <div className="jam-lobby">
      <JamLobbyHeader title="Jam" onBack={onBack} />
      {/* Without the server the rooms are unknown and none can be opened or
          joined: only that is shown until it is back */}
      {unreachable ? (
        <div className="jam-lobby-note">Can&apos;t reach the rooms. Trying again…</div>
      ) : (
        <>
          {ended && <div className="jam-lobby-note">{ENDED[ended]}</div>}
          {rooms && (
            <div className="jam-lobby-grid">
              <NewRoomCard tracks={tracks} onCreate={(create) => onEnter({ key: newJamRoomCode(), create })} />
              {rooms.map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  onEnter={onEnter}
                  check={(code) => check(room.id, code)}
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
// long as it lasts), then open to everyone or private with a code
function NewRoomCard({
  tracks,
  onCreate,
}: {
  tracks: JamLobbyTrack[];
  onCreate: (create: { visibility: JamRoomVisibility; song: string }) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [song, setSong] = useState('');
  if (!choosing) {
    return (
      <button className="jam-lobby-card jam-lobby-new" onClick={() => setChoosing(true)}>
        <span className="jam-lobby-plus">+</span>
        New room
      </button>
    );
  }
  const options = (daw: boolean) =>
    tracks.filter((track) => track.daw === daw).map((track) => ({ value: track.id, label: track.title, detail: `${track.bpm} BPM` }));
  const groups = [
    { label: 'Songs', options: options(false) },
    { label: 'Daw', options: options(true) },
  ].filter((group) => group.options.length);
  return (
    <div className="jam-lobby-card jam-lobby-new jam-lobby-choosing">
      <div className="jam-lobby-card-head">New room</div>
      <JamDropdown groups={groups} value={song} onChange={setSong} placeholder="Track" autoFocus />
      {song && (
        <div className="jam-lobby-choices">
          <button className="jam-lobby-choice" onClick={() => onCreate({ visibility: 'open', song })}>
            Open
          </button>
          <button className="jam-lobby-choice" onClick={() => onCreate({ visibility: 'private', song })}>
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
}

// A live room: its song and players. An open room is joined with a click; a
// private room asks for its code on the card first.
function RoomCard({ room, onEnter, check }: RoomCardProps) {
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const body = (
    <>
      <div className="jam-lobby-card-top">
        <span className={`jam-lobby-badge ${room.visibility}`}>
          {room.visibility === 'private' && <LockIcon />}
          {room.visibility === 'open' ? 'Open' : 'Private'}
        </span>
        <span className="jam-lobby-count">
          {room.full ? 'Full' : `${room.players.length}/${JAM_ROOM_MAX_PLAYERS}`}
        </span>
      </div>
      <div className="jam-lobby-title">{room.host}&apos;s room</div>
      <div className="jam-lobby-song">
        {room.playing && <span className="jam-lobby-live" />}
        {room.song.title}
        <span className="jam-lobby-bpm">{room.song.bpm} BPM</span>
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

  if (room.visibility === 'open' || !asking) {
    return (
      <button
        className="jam-lobby-card"
        disabled={room.full}
        onClick={() => (room.visibility === 'open' && room.key ? onEnter({ key: room.key }) : setAsking(true))}
      >
        {body}
      </button>
    );
  }

  const submit = async () => {
    if (!JAM_ROOM_CODE.test(code) || checking) return;
    startJamAudio(); // now, while this is still the player's click
    setChecking(true);
    const ok = await check(code);
    setChecking(false);
    if (ok) onEnter({ key: code });
    else setProblem(ok === false ? 'Wrong code' : "Can't reach the rooms");
  };

  return (
    <div className="jam-lobby-card jam-lobby-asking">
      {body}
      <form
        className="jam-lobby-code"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
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
        <button type="submit" disabled={!JAM_ROOM_CODE.test(code) || checking}>
          Join
        </button>
        <button type="button" className="jam-lobby-cancel" onClick={() => setAsking(false)} title="Cancel">
          &times;
        </button>
      </form>
      {problem && <div className="jam-lobby-problem">{problem}</div>}
    </div>
  );
}
