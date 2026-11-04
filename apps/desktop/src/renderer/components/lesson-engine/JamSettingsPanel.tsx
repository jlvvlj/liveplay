import { Fragment, useState } from 'react';
import {
  JAM_FILTER_OPEN,
  JAM_SYNTH_CONTROLS,
  JAM_ECHO_BEATS,
  SYNTH_FAMILIES,
  type JamSoundPreset,
  type JamSampleSound,
  type JamSynthPatch,
  type JamSynthControl,
  type JamEffects,
  type JamEchoTime,
} from './jamSynth';
import type { Lesson } from '../../types/lesson';
import { BackIcon, SidebarIcon } from './JamIcons';
import type { JamRoomPlayer } from './jamRoom';
import { JAM_ROOM_NAME_MAX } from './jamRoomProtocol';

interface JamSettingsPanelProps {
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
  sounds: JamSoundPreset[];
  referenceSounds: JamSampleSound[];
  soundId: string;
  onSoundChange: (id: string) => void;
  // Settings of the chosen synth sound; none for a recorded reference sound
  patch: JamSynthPatch | undefined;
  onPatchChange: (patch: JamSynthPatch) => void;
  onPatchReset: () => void;
  holdDivisions: number[];
  holdDivision: number;
  onHoldDivisionChange: (division: number) => void;
  holdTriplet: boolean;
  onHoldTripletChange: (triplet: boolean) => void;
  notesVolume: number;
  onNotesVolumeChange: (volume: number) => void;
  backingVolume: number;
  onBackingVolumeChange: (volume: number) => void;
  effects: JamEffects;
  onEffectsChange: (effects: JamEffects) => void;
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

const FAMILY_LABELS: Record<string, string> = {
  sine: 'Sine',
  triangle: 'Triangle',
  saw: 'Saw',
  square: 'Square',
  pulse: 'Pulse',
  fm: 'FM',
};

const SECONDS = new Set(['attack', 'decay', 'hold', 'release', 'sweepTime']);

function formatControl(control: JamSynthControl, value: number): string {
  if (SECONDS.has(control.key)) return value < 0.1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
  if (control.key === 'octave') return value > 0 ? `+${value}` : `${value}`;
  if (control.key === 'cutoff' || control.key === 'cutoffEnd') return value >= JAM_FILTER_OPEN ? 'Open' : `×${value.toFixed(1)}`;
  if (control.key === 'vibrato') return `${value} ct`;
  if (control.key === 'ratio') return `×${value}`;
  if (control.key === 'detune') return `${value} ct`;
  if (control.key === 'odd') return `${Math.round((0.12 + 0.32 * value) * 100)}%`; // pulse duty cycle
  if (control.key === 'fm') return value.toFixed(2);
  return `${Math.round(value * 100)}%`;
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
  songs,
  songId,
  onSongChange,
  room,
  roomName = '',
  onRoomNameChange,
  view,
  onViewChange,
  sounds,
  referenceSounds,
  soundId,
  onSoundChange,
  patch,
  onPatchChange,
  onPatchReset,
  holdDivisions,
  holdDivision,
  onHoldDivisionChange,
  holdTriplet,
  onHoldTripletChange,
  notesVolume,
  onNotesVolumeChange,
  backingVolume,
  onBackingVolumeChange,
  effects,
  onEffectsChange,
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
  const [linkCopied, setLinkCopied] = useState(false);
  const setEffect = <K extends keyof JamEffects>(key: K, value: JamEffects[K]) =>
    onEffectsChange({ ...effects, [key]: value });
  // Songs with recorded sounds, each listed under its name: drums & FX, then instruments
  const soundSongs = [...new Set(sounds.flatMap((sound) => ('song' in sound ? [sound.song] : [])))];

  const soundGrid = (choices: { id: string; label: string }[]) => (
    <div className="jam-sound-grid">
      {choices.map((sound) => (
        <button
          key={sound.id}
          className={`jam-sound-option ${sound.id === soundId ? 'active' : ''}`}
          onClick={() => onSoundChange(sound.id)}
        >
          {sound.label}
        </button>
      ))}
    </div>
  );

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
            Sound
          </label>
          <div className="jam-subhead">Instruments</div>
          {soundGrid(sounds.filter((sound) => 'patch' in sound))}
          <div className="jam-subhead">Drums</div>
          {soundGrid(sounds.filter((sound) => 'kit' in sound))}
          {soundSongs.map((song) => (
            <Fragment key={song}>
              <div className="jam-subhead">{song}</div>
              {soundGrid(sounds.filter((sound) => 'song' in sound && sound.song === song))}
            </Fragment>
          ))}
          {referenceSounds.length > 0 && (
            <>
              <div className="jam-subhead">Reference</div>
              {soundGrid(referenceSounds)}
            </>
          )}
        </div>

        {patch && (
        <div className="setting-group">
          <label className="setting-label">
            <span className="setting-icon">&#127899;</span>
            Synth
            <button className="jam-reset" onClick={onPatchReset}>
              Reset
            </button>
          </label>
          <div className="jam-family-options">
            {SYNTH_FAMILIES.map((family) => (
              <button
                key={family}
                className={`jam-sound-option ${family === patch.family ? 'active' : ''}`}
                onClick={() => onPatchChange({ ...patch, family })}
              >
                {FAMILY_LABELS[family] ?? family}
              </button>
            ))}
          </div>
          {JAM_SYNTH_CONTROLS.filter((control) => !control.families || control.families.includes(patch.family)).map(
            (control) => (
              <Slider
                key={control.key}
                label={control.label}
                value={patch[control.key]}
                display={formatControl(control, patch[control.key])}
                min={control.min}
                max={control.max}
                step={control.step}
                onChange={(value) => onPatchChange({ ...patch, [control.key]: value })}
              />
            )
          )}
        </div>
        )}

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
        </div>

        <div className="setting-group">
          <label className="setting-label">
            <span className="setting-icon">&#127754;</span>
            Effects
          </label>
          <div className="jam-subhead">Reverb</div>
          <Slider
            label="Mix"
            value={effects.reverbMix}
            display={`${Math.round(effects.reverbMix * 100)}%`}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => setEffect('reverbMix', value)}
          />
          <Slider
            label="Size"
            value={effects.reverbSize}
            display={`${effects.reverbSize.toFixed(1)} s`}
            min={0.5}
            max={8}
            step={0.1}
            onChange={(value) => setEffect('reverbSize', value)}
          />
          <div className="jam-subhead">Echo</div>
          <Slider
            label="Mix"
            value={effects.echoMix}
            display={`${Math.round(effects.echoMix * 100)}%`}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => setEffect('echoMix', value)}
          />
          <div className="jam-slider-head">
            <span>Time</span>
          </div>
          <div className="jam-sound-options jam-hold-options">
            {(Object.keys(JAM_ECHO_BEATS) as JamEchoTime[]).map((time) => (
              <button
                key={time}
                className={`jam-sound-option ${time === effects.echoTime ? 'active' : ''}`}
                onClick={() => setEffect('echoTime', time)}
              >
                {time}
              </button>
            ))}
          </div>
          <Slider
            label="Feedback"
            value={effects.echoFeedback}
            display={`${Math.round(effects.echoFeedback * 100)}%`}
            min={0}
            max={0.9}
            step={0.01}
            onChange={(value) => setEffect('echoFeedback', value)}
          />
        </div>

        <div className="setting-group">
          <label className="setting-label">
            <span className="setting-icon">&#128266;</span>
            Volume
          </label>
          <Slider
            label="Notes"
            value={notesVolume}
            display={`${Math.round(notesVolume * 100)}%`}
            min={0}
            max={1}
            step={0.05}
            onChange={onNotesVolumeChange}
          />
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
      </div>
    </div>
  );
}
