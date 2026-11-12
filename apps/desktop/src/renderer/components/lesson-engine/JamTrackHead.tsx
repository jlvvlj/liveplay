import { useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { JAM_TRACK_NAME_MAX } from './jamTrackEdits';
import './JamLaneStrip.css';
import './JamTrackHead.css';

// A track's header in the Daw's timeline: its name (pressed, it is typed
// anew), what plays it (pressed, its instruments open), then its solo, mute
// and level.

interface JamTrackHeadProps {
  name: string;
  // What plays the track; none for a recording
  instrument?: string;
  solo: boolean;
  mute: boolean;
  level: number; // 0 to 1
  onRename: (name: string) => void;
  onInstrument?: () => void;
  onSolo: () => void;
  onMute: () => void;
  onLevel: (level: number) => void;
}

// The header's presses are its own, never the grid's under it
const keepPointer = (event: ReactPointerEvent) => event.stopPropagation();
// Buttons give focus back, so the keys keep playing notes
const blurAfter = (action: () => void) => (event: ReactMouseEvent<HTMLButtonElement>) => {
  action();
  event.currentTarget.blur();
};

export function JamTrackHead({ name, instrument, solo, mute, level, onRename, onInstrument, onSolo, onMute, onLevel }: JamTrackHeadProps) {
  // The name as it is being typed
  const [typed, setTyped] = useState<string | null>(null);
  // Escape leaves the name as it was, however the field then loses focus
  const kept = useRef(true);
  const start = () => {
    kept.current = true;
    setTyped(name);
  };
  const done = () => {
    if (typed === null) return;
    setTyped(null);
    if (kept.current && typed.trim() !== name) onRename(typed);
  };

  return (
    <div className="jam-track-head" onPointerDown={keepPointer} onPointerMove={keepPointer}>
      {typed === null ? (
        <button className="jam-track-head-name" onClick={start} title={name} aria-label={`Rename ${name}`}>
          {name}
        </button>
      ) : (
        <input
          className="jam-track-head-name editing"
          value={typed}
          maxLength={JAM_TRACK_NAME_MAX}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={done}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            else if (event.key === 'Escape') {
              kept.current = false;
              event.currentTarget.blur();
            }
          }}
          aria-label="Track name"
        />
      )}
      {instrument !== undefined &&
        (onInstrument ? (
          <button className="jam-track-head-instrument" onClick={blurAfter(onInstrument)}>
            {instrument}
          </button>
        ) : (
          <span className="jam-track-head-instrument">{instrument}</span>
        ))}
      <div className="jam-track-head-controls">
        <button className={`jam-lane-toggle solo ${solo ? 'on' : ''}`} onClick={blurAfter(onSolo)} aria-label={`Solo ${name}`}>
          S
        </button>
        <button className={`jam-lane-toggle mute ${mute ? 'on' : ''}`} onClick={blurAfter(onMute)} aria-label={`Mute ${name}`}>
          M
        </button>
        <input
          className="jam-lane-level"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={level}
          style={{ '--level': `${level * 100}%` } as CSSProperties}
          onChange={(event) => onLevel(parseFloat(event.target.value))}
          onPointerUp={(event) => event.currentTarget.blur()}
          aria-label={`${name} level`}
        />
      </div>
    </div>
  );
}
