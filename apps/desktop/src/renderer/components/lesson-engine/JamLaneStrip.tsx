import { forwardRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import './JamLaneStrip.css';

// A lane's controls in the Jam tab, the same beside the step grid and the
// highway: its name with a tag (the grid's resolution, the highway's key),
// solo, mute and a level. Folded away, they are not shown at all.

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

// The strip sits over the highway's rows, which play on press: its presses are its own
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

// The bar between the lane controls and the lanes that folds the controls away and back
export const JamLanesHandle = forwardRef<HTMLButtonElement, { open: boolean; onToggle: () => void }>(function JamLanesHandle(
  { open, onToggle },
  ref
) {
  return (
    <button
      ref={ref}
      className="jam-lanes-handle"
      onPointerDown={keepPointer}
      onPointerMove={keepPointer}
      onClick={blurAfter(onToggle)}
      aria-label={open ? 'Hide lane controls' : 'Show lane controls'}
    >
      {open ? '‹' : '›'}
    </button>
  );
});
