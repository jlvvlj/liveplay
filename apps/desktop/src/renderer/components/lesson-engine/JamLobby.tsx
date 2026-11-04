import { useState } from 'react';
import type { Lesson } from '../../types/lesson';
import { newJamRoomCode, type JamRoomEnd } from './jamRoom';
import {
  JAM_ROOM_CODE,
  JAM_ROOM_MAX_PLAYERS,
  type JamRoomSummary,
  type JamRoomVisibility,
} from './jamRoomProtocol';
import './JamLobby.css';

// The jam app's home: every live room as a card, open rooms joined with a
// click and private ones with their code, and a card to open a new room.

export interface JamRoomEntry {
  key: string;
  create?: JamRoomVisibility;
}

interface JamLobbyProps {
  // The live rooms (null until the server first answers), whether the
  // server cannot be reached right now, and a check of a private room's code
  rooms: JamRoomSummary[] | null;
  unreachable: boolean;
  check: (id: string, code: string) => Promise<boolean | null>;
  songs: Lesson[];
  onEnter: (entry: JamRoomEntry) => void;
  // Why the player is back here, when the room ended by itself
  ended?: JamRoomEnd | null;
}

const ENDED: Record<JamRoomEnd, string> = {
  full: 'That room is full',
  missing: 'That room has ended',
  lost: 'The connection to the room was lost',
};

const LockIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2.2" />
  </svg>
);

export function JamLobby({ rooms, unreachable, check, songs, onEnter, ended }: JamLobbyProps) {
  return (
    <div className="jam-lobby">
      <header className="jam-lobby-header">
        <h1>Jam</h1>
      </header>
      {ended && <div className="jam-lobby-note">{ENDED[ended]}</div>}
      {unreachable && <div className="jam-lobby-note">Can&apos;t reach the rooms</div>}
      <div className="jam-lobby-grid">
        <NewRoomCard onCreate={(create) => onEnter({ key: newJamRoomCode(), create })} />
        {(rooms ?? []).map((room) => (
          <RoomCard
            key={room.id}
            room={room}
            song={songs.find((song) => song.id === room.songId)}
            onEnter={onEnter}
            check={(code) => check(room.id, code)}
          />
        ))}
      </div>
    </div>
  );
}

// The card that opens a new room: open to everyone, or private with a code
function NewRoomCard({ onCreate }: { onCreate: (visibility: JamRoomVisibility) => void }) {
  const [choosing, setChoosing] = useState(false);
  if (!choosing) {
    return (
      <button className="jam-lobby-card jam-lobby-new" onClick={() => setChoosing(true)}>
        <span className="jam-lobby-plus">+</span>
        New room
      </button>
    );
  }
  return (
    <div className="jam-lobby-card jam-lobby-new jam-lobby-choosing">
      <button className="jam-lobby-choice" onClick={() => onCreate('open')}>
        Open
      </button>
      <button className="jam-lobby-choice" onClick={() => onCreate('private')}>
        <LockIcon />
        Private
      </button>
      <button className="jam-lobby-cancel" onClick={() => setChoosing(false)} title="Cancel">
        &times;
      </button>
    </div>
  );
}

interface RoomCardProps {
  room: JamRoomSummary;
  song: Lesson | undefined;
  onEnter: (entry: JamRoomEntry) => void;
  check: (code: string) => Promise<boolean | null>;
}

// A live room: its song and players. An open room is joined with a click; a
// private room asks for its code on the card first.
function RoomCard({ room, song, onEnter, check }: RoomCardProps) {
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
      <div className="jam-lobby-song">
        {room.playing && <span className="jam-lobby-live" />}
        {song?.title ?? room.songId}
        {song && <span className="jam-lobby-bpm">{song.bpm} BPM</span>}
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
