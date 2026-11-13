import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';

// A parameter's knob: turned by dragging up and down (finer with Shift), by
// the arrow keys, or back to its default with a double-click; its value shows
// above it while it is hovered, turned, or focused from the keyboard. A `log`
// knob (frequencies, times, rates) turns evenly through its range's octaves
// rather than through its numbers; a range either side of zero lights from zero.

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  default: number;
  // Turned through octaves (its range above zero)
  log?: boolean;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

// The knob turns 270°, its gap at the bottom
const SWEEP = 270;
// Pixels dragged for the whole range, and with Shift
const DRAG_PX = 200;
const FINE_PX = 1000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function scale(min: number, max: number, octaves: boolean) {
  const log = octaves && min > 0;
  return {
    // A value's place along the knob, 0 to 1
    at: (value: number) =>
      log ? Math.log(clamp(value, min, max) / min) / Math.log(max / min) : (clamp(value, min, max) - min) / (max - min),
    // The value at a place along the knob
    of: (place: number) => {
      const p = clamp(place, 0, 1);
      return log ? min * Math.pow(max / min, p) : min + p * (max - min);
    },
  };
}

// An arc of the ring, from one place along the knob to another
function arc(from: number, to: number, r: number) {
  const angle = (place: number) => ((place * SWEEP - SWEEP / 2) * Math.PI) / 180;
  const point = (place: number) => `${24 + r * Math.sin(angle(place))} ${24 - r * Math.cos(angle(place))}`;
  const large = Math.abs(to - from) * SWEEP > 180 ? 1 : 0;
  return `M ${point(from)} A ${r} ${r} 0 ${large} 1 ${point(to)}`;
}

export function Knob({ label, value, min, max, step, default: initial, log = false, format, onChange }: KnobProps) {
  const { at, of } = scale(min, max, log);
  const snap = useCallback(
    (raw: number) => {
      const snapped = Math.round((raw - min) / step) * step + min;
      return clamp(Number(snapped.toFixed(6)), min, max);
    },
    [min, max, step]
  );
  const knob = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; place: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [turning, setTurning] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const shown = hovered || focused || turning;

  // The value's tip, over the knob wherever it is scrolled to
  useEffect(() => {
    if (!shown) return setTip(null);
    const place = () => {
      const rect = knob.current!.getBoundingClientRect();
      setTip({ x: rect.left + rect.width / 2, y: rect.top });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [shown]);

  const set = (next: number) => {
    const snapped = snap(next);
    if (snapped !== value) onChange(snapped);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    knob.current!.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, place: at(value) };
    setTurning(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const px = event.shiftKey ? FINE_PX : DRAG_PX;
    const place = start.place + (start.y - event.clientY) / px;
    // A drag past either end starts back from that end
    if (place < 0 || place > 1) drag.current = { y: event.clientY, place: clamp(place, 0, 1) };
    set(of(place));
  };
  const onPointerUp = () => {
    drag.current = null;
    setTurning(false);
  };

  // A key's turn moves at least one step
  const turn = (places: number) => {
    const next = snap(of(at(value) + places));
    set(next !== value ? next : value + Math.sign(places) * step);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const fine = event.shiftKey ? 0.2 : 1;
    const keys: Record<string, () => void> = {
      ArrowUp: () => turn(0.01 * fine),
      ArrowRight: () => turn(0.01 * fine),
      ArrowDown: () => turn(-0.01 * fine),
      ArrowLeft: () => turn(-0.01 * fine),
      PageUp: () => turn(0.1),
      PageDown: () => turn(-0.1),
      Home: () => set(min),
      End: () => set(max),
    };
    const key = keys[event.key];
    if (!key) return;
    event.preventDefault();
    setFocused(true);
    key();
  };

  const place = at(value);
  // Lit from zero when the range is either side of it, else from its start
  const zero = min < 0 && max > 0 ? at(0) : 0;
  const text = format(value);

  return (
    <div className={`knob ${turning ? 'turning' : ''}`}>
      <div
        ref={knob}
        className="knob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        // Focus from the keyboard shows the value; a click's waits for the pointer
        onFocus={(event) => setFocused(event.currentTarget.matches(':focus-visible'))}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        onDoubleClick={() => set(initial)}
      >
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path className="knob-track" d={arc(0, 1, 21)} />
          {Math.abs(place - zero) > 0.002 && (
            <path className="knob-lit" d={arc(Math.min(zero, place), Math.max(zero, place), 21)} />
          )}
        </svg>
        <div className="knob-cap" style={{ transform: `rotate(${place * SWEEP - SWEEP / 2}deg)` }}>
          <span className="knob-mark" />
        </div>
      </div>
      <span className="knob-label">{label}</span>
      {tip &&
        createPortal(
          <div className="knob-tip" style={{ left: tip.x, top: tip.y }} role="presentation">
            {text}
          </div>,
          document.body
        )}
    </div>
  );
}
