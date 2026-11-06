import { useState } from 'react';
import type { Lesson } from '../../types/lesson';
import { BackIcon, SYNTH_TAG_ICONS, SidebarIcon } from './JamIcons';
import { CategoryArt } from './instruments/CategoryArt';
import type { JamRoomPlayer } from './jamRoom';
import { JAM_ROOM_NAME_MAX } from './jamRoomProtocol';

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

export function JamSettingsPanel({
  section,
  songs,
  songId,
  onSongChange,
  room,
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

        {playing && (
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
        </>
        )}
      </div>
    </div>
  );
}
