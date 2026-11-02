import {
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

interface JamSettingsPanelProps {
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
  onBack: () => void;
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

const SECONDS = new Set(['attack', 'decay', 'hold', 'release']);

function formatControl(control: JamSynthControl, value: number): string {
  if (SECONDS.has(control.key)) return value < 0.1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
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
  const setEffect = <K extends keyof JamEffects>(key: K, value: JamEffects[K]) =>
    onEffectsChange({ ...effects, [key]: value });

  return (
    <div className="game-settings-sidebar">
      <div className="game-settings-header jam-settings-header">
        <button className="jam-corner-btn" onClick={onBack} title="Back">
          &#8592;
        </button>
        <div className="jam-song">
          <span className="jam-song-title">{title}</span>
          <span className="toolbar-badge">{bpm} BPM</span>
        </div>
        <button className="jam-corner-btn" onClick={onClose} title="Hide settings">
          &#171;
        </button>
      </div>

      <div className="game-settings-content">
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
          <div className="jam-sound-grid">
            {sounds.map((sound) => (
              <button
                key={sound.id}
                className={`jam-sound-option ${sound.id === soundId ? 'active' : ''}`}
                onClick={() => onSoundChange(sound.id)}
              >
                {sound.label}
              </button>
            ))}
          </div>
          {referenceSounds.length > 0 && (
            <>
              <div className="jam-subhead">Reference</div>
              <div className="jam-sound-grid">
                {referenceSounds.map((sound) => (
                  <button
                    key={sound.id}
                    className={`jam-sound-option ${sound.id === soundId ? 'active' : ''}`}
                    onClick={() => onSoundChange(sound.id)}
                  >
                    {sound.label}
                  </button>
                ))}
              </div>
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
            <span className="setting-value">1/{holdDivision}</span>
          </label>
          <div className="jam-sound-options jam-hold-options">
            {holdDivisions.map((division) => (
              <button
                key={division}
                className={`jam-sound-option ${division === holdDivision ? 'active' : ''}`}
                onClick={() => onHoldDivisionChange(division)}
              >
                {division}
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
