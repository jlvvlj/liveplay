import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import './JamLaneStrip.css';

// A track's or a row's controls in the Jam tab's grid: its name with a tag,
// solo, mute and a level.

interface JamLaneStripProps {
  name: string;
  tag: string;
  tagColor?: string;
  solo: boolean;
  mute: boolean;
  level: number; // 0 to 1
  onNameClick?: () => void;
  onSolo: () => void;
  onMute: () => void;
  onLevel: (level: number) => void;
}

// The strip's presses are its own, never the grid's under it
const keepPointer = (event: ReactPointerEvent) => event.stopPropagation();
// Buttons give focus back, so the keys keep playing notes
const blurAfter = (action: () => void) => (event: ReactMouseEvent<HTMLButtonElement>) => {
  action();
  event.currentTarget.blur();
};

export function JamLaneStrip({
  name,
  tag,
  tagColor,
  solo,
  mute,
  level,
  onNameClick,
  onSolo,
  onMute,
  onLevel,
}: JamLaneStripProps) {
  const nameLabel = (
    <>
      <span className="jam-lane-title">{name}</span>
      <span className="jam-lane-tag" style={tagColor ? { color: tagColor } : undefined}>
        {tag}
      </span>
    </>
  );
  return (
    <div className="jam-lane-strip" onPointerDown={keepPointer} onPointerMove={keepPointer}>
      {onNameClick ? (
        <button className="jam-lane-name" onClick={blurAfter(onNameClick)}>
          {nameLabel}
        </button>
      ) : (
        <div className="jam-lane-name">{nameLabel}</div>
      )}
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
        onChange={(event) => onLevel(parseFloat(event.target.value))}
        onPointerUp={(event) => event.currentTarget.blur()}
        aria-label={`${name} level`}
      />
    </div>
  );
}
