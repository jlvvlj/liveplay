import { useState } from 'react';
import type { Lesson } from '../../types/lesson';
import type { JamRoomEnd } from './jamRoom';
import { JAM_SONG_TITLE_MAX, type JamDawSongSummary } from './jamRoomProtocol';
import { JAM_DAW_MAX_BPM, JAM_DAW_MIN_BPM, jamBpmLabel } from './jamTracks';
import { JamLobbyHeader, startJamAudio } from './JamLobby';
import { JamDropdown } from './JamDropdown';
import type { ProjectFile } from '../../utils/abletonImport';
import type { JamImportStep } from './jamAbletonImport';
import { useAbletonImport } from './useAbletonImport';
import './JamLobby.css';

// The jam app's Daw section: every Daw song as a card, opened with a click to
// edit its grid together with whoever else has it open, and offered to new
// Jam rooms with its switch; and a card to make a new song.

interface DawLobbyProps {
  // The songs (null until the server first answers), and whether the server
  // cannot be reached right now
  songs: JamDawSongSummary[] | null;
  unreachable: boolean;
  // Built-in songs a new song can start from
  builtIns: Lesson[];
  onOpen: (id: string) => void;
  // A new song: its id, or null when it could not be made
  onNew: (title: string, from: string | null, bpm: number) => Promise<string | null>;
  onOffer: (id: string, offered: boolean) => void;
  // An Ableton project's folder made a Daw song: its id
  onImport: (files: ProjectFile[], onStep: (step: JamImportStep) => void) => Promise<string>;
  onBack: () => void;
  // Why the player is back here, when the song's room ended by itself
  ended?: JamRoomEnd | null;
}

const ENDED: Record<JamRoomEnd, string> = {
  full: 'That song has too many players right now',
  missing: 'That song no longer exists',
  lost: 'The connection to the song was lost',
  song: "That song's recordings could not be loaded",
};

const NEW_TITLE = 'Untitled';
const NEW_BPM = 120;

export function DawLobby({ songs, unreachable, builtIns, onOpen: openSong, onNew, onOffer, onImport, onBack, ended }: DawLobbyProps) {
  const onOpen = (id: string) => {
    startJamAudio();
    openSong(id);
  };
  return (
    <div className="jam-lobby">
      <JamLobbyHeader title="Daw" onBack={onBack} />
      {unreachable ? (
        <div className="jam-lobby-note">Can&apos;t reach the songs. Trying again…</div>
      ) : (
        <>
          {ended && <div className="jam-lobby-note">{ENDED[ended]}</div>}
          {songs && (
            <div className="jam-lobby-grid">
              <NewSongCard builtIns={builtIns} onNew={onNew} onOpen={onOpen} />
              <ImportCard onImport={onImport} onOpen={onOpen} />
              {songs.map((song) => (
                <SongCard key={song.id} song={song} onOpen={() => onOpen(song.id)} onOffer={(offered) => onOffer(song.id, offered)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const IMPORT_STAGES: Record<JamImportStep['stage'], string> = {
  reading: 'Reading the project',
  analyzing: 'Finding the hits in',
  encoding: 'Sending',
};

// The card that imports an Ableton project: its folder is read as the Lessons
// tab reads it, every exported track sent, and the new song opens
function ImportCard({ onImport, onOpen }: { onImport: DawLobbyProps['onImport']; onOpen: (id: string) => void }) {
  const { pick, inputProps, step, share, problem } = useAbletonImport(async (files, onStep) => onOpen(await onImport(files, onStep)));
  return (
    <button className={`jam-lobby-card jam-lobby-new jam-lobby-import ${step ? 'busy' : ''}`} onClick={pick} disabled={!!step}>
      <input {...inputProps} />
      {step ? (
        <>
          <span className="jam-lobby-import-stage">
            {IMPORT_STAGES[step.stage]}
            {step.stage !== 'reading' && ` ${step.track}`}
          </span>
          {step.stage !== 'reading' && (
            <span className="jam-lobby-import-count">
              {step.done + 1} / {step.total}
            </span>
          )}
          <span className="jam-lobby-import-bar">
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
        </>
      ) : (
        <>
          <span className="jam-lobby-plus">+</span>
          Import Ableton project
          {problem && <span className="jam-lobby-problem">{problem}</span>}
        </>
      )}
    </button>
  );
}

// The card that makes a new song: its name, and what it starts from (a
// built-in song, or nothing at a chosen tempo); made, it opens
function NewSongCard({
  builtIns,
  onNew,
  onOpen,
}: {
  builtIns: Lesson[];
  onNew: DawLobbyProps['onNew'];
  onOpen: (id: string) => void;
}) {
  const [making, setMaking] = useState(false);
  const [title, setTitle] = useState(NEW_TITLE);
  const [from, setFrom] = useState('');
  const [bpm, setBpm] = useState(NEW_BPM);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  if (!making) {
    return (
      <button className="jam-lobby-card jam-lobby-new" onClick={() => setMaking(true)}>
        <span className="jam-lobby-plus">+</span>
        New song
      </button>
    );
  }
  const close = () => {
    setMaking(false);
    setTitle(NEW_TITLE);
    setFrom('');
    setBpm(NEW_BPM);
    setProblem(false);
  };
  const submit = async () => {
    if (busy) return;
    startJamAudio(); // now, while this is still the player's click
    setBusy(true);
    const id = await onNew(title.trim() || NEW_TITLE, from || null, Math.min(JAM_DAW_MAX_BPM, Math.max(JAM_DAW_MIN_BPM, Math.round(bpm))));
    setBusy(false);
    if (id) onOpen(id);
    else setProblem(true);
  };
  return (
    <form
      className="jam-lobby-card jam-lobby-new jam-lobby-choosing jam-lobby-making"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="jam-lobby-card-head">New song</div>
      <input
        className="jam-lobby-field jam-lobby-name"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onFocus={(event) => event.target.select()}
        maxLength={JAM_SONG_TITLE_MAX}
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <div className="jam-lobby-start">
        <JamDropdown
          className="jam-lobby-from"
          value={from}
          onChange={setFrom}
          groups={[
            { options: [{ value: '', label: 'Empty' }] },
            { label: 'Songs', options: builtIns.map((song) => ({ value: song.id, label: song.title, detail: `${song.bpm} BPM` })) },
          ]}
        />
        {from === '' && (
          <label className="jam-lobby-bpm-field">
            <input
              type="number"
              min={JAM_DAW_MIN_BPM}
              max={JAM_DAW_MAX_BPM}
              value={bpm}
              onChange={(event) => setBpm(Number(event.target.value))}
            />
            BPM
          </label>
        )}
      </div>
      <button type="submit" className="jam-lobby-choice" disabled={busy}>
        Create
      </button>
      {problem && <div className="jam-lobby-problem">Can&apos;t reach the songs</div>}
      <button type="button" className="jam-lobby-cancel" onClick={close} title="Cancel">
        &times;
      </button>
    </form>
  );
}

// A song: its tempo, who is editing it now, and whether new Jam rooms can play it
function SongCard({ song, onOpen, onOffer }: { song: JamDawSongSummary; onOpen: () => void; onOffer: (offered: boolean) => void }) {
  return (
    <div className="jam-lobby-card jam-lobby-song-card">
      <button className="jam-lobby-open" onClick={onOpen} title={`Open ${song.title}`} />
      <div className="jam-lobby-card-top">
        <span className="jam-lobby-bpm">{jamBpmLabel(song.bpm)}</span>
        <label className="jam-lobby-offer">
          Jam
          <input type="checkbox" checked={song.offered} onChange={(event) => onOffer(event.target.checked)} />
          <span className="jam-lobby-switch" />
        </label>
      </div>
      <div className="jam-lobby-title">{song.title}</div>
      <div className="jam-lobby-players">
        {song.editors.map((player, index) => (
          <span key={index} className="jam-lobby-player">
            <span className="jam-lobby-dot" style={{ background: player.color }} />
            {player.name}
          </span>
        ))}
      </div>
    </div>
  );
}
