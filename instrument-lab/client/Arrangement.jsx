import React, { useEffect, useRef, useState } from "react";
import { audibleIds, clamp, zoomWindow } from "./timeline.mjs";
const stamp = (s) => {
  const ticks = Math.round(s * 10);
  return `${Math.floor(ticks / 600)}:${((ticks % 600) / 10).toFixed(1).padStart(4, "0")}`;
};
const Overview = React.memo(function Overview({ part, start, span }) {
  const pitches = part.notes.map((n) => n.pitch);
  const low = pitches.length ? Math.min(...pitches) - 2 : 48;
  const high = pitches.length ? Math.max(...pitches) + 2 : 72;
  return (
    <svg viewBox="0 0 1000 54" preserveAspectRatio="none" aria-hidden="true">
      {part.notes
        .filter((n) => n.end >= start && n.start <= start + span)
        .map((n, i) => (
          <rect
            key={i}
            x={Math.max(0, ((n.start - start) / span) * 1000)}
            y={5 + ((high - n.pitch) / (high - low)) * 38}
            width={Math.max(
              2,
              ((n.end - Math.max(n.start, start)) / span) * 1000,
            )}
            height="4"
            rx="2"
          />
        ))}
    </svg>
  );
});
export default function Arrangement({
  parts,
  duration,
  selected,
  colors,
  time,
  active,
  preparing,
  busy,
  muted,
  solo,
  onSelect,
  onSeek,
  onPlay,
  onToggle,
  onMerge,
}) {
  const [view, setView] = useState([0, duration]);
  const [scrub, setScrub] = useState(null);
  const [merge, setMerge] = useState(null);
  const root = useRef(null),
    gesture = useRef(null);
  const [start, span] = view;
  const position = scrub ?? time;
  const audible = audibleIds(parts, muted, solo);
  const zoom = (focus, factor) =>
    setView((v) => zoomWindow(v[0], v[1], duration, focus, factor));
  // A non-passive listener prevents browser zoom and keeps trackpad gestures in this timeline.
  useEffect(() => {
    const node = root.current;
    const wheel = (e) => {
      const lane = e.target.closest("[data-timeline]");
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      if (e.ctrlKey) {
        e.preventDefault();
        setView((v) =>
          zoomWindow(
            v[0],
            v[1],
            duration,
            v[0] + clamp((e.clientX - rect.left) / rect.width, 0, 1) * v[1],
            e.deltaY > 0 ? 1.25 : 0.8,
          ),
        );
      } else {
        const delta = e.deltaX || (e.shiftKey ? e.deltaY : 0);
        if (!delta) return;
        e.preventDefault();
        const pixels =
          delta * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.width : 1);
        setView((v) => [
          clamp(v[0] + (pixels * v[1]) / rect.width, 0, duration - v[1]),
          v[1],
        ]);
      }
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [duration]);
  const atPointer = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return clamp(
      start + ((e.clientX - rect.left) / rect.width) * span,
      0,
      duration,
    );
  };
  const seekHandlers = {
    onPointerDown: (e) => {
      if (e.button !== 0 || busy) return;
      e.preventDefault();
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
      gesture.current = e.pointerId;
      setScrub(atPointer(e));
    },
    onPointerMove: (e) => {
      if (gesture.current === e.pointerId) setScrub(atPointer(e));
    },
    onPointerUp: (e) => {
      if (gesture.current !== e.pointerId) return;
      gesture.current = null;
      onSeek(atPointer(e));
      setScrub(null);
    },
    onPointerCancel: () => {
      gesture.current = null;
      setScrub(null);
    },
    onKeyDown: (e) => {
      const steps = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 };
      if (!(e.key in steps) && !["Home", "End"].includes(e.key)) return;
      e.preventDefault();
      onSeek(
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? duration
            : clamp(time + steps[e.key] * (e.shiftKey ? 5 : 1), 0, duration),
      );
    },
  };
  const head = position >= start && position <= start + span && (
    <i
      className="arrangement-playhead"
      style={{ left: `${((position - start) / span) * 100}%` }}
    />
  );
  const sliderProps = (label) => ({
    role: "slider",
    tabIndex: busy ? -1 : 0,
    "aria-label": label,
    "aria-valuemin": 0,
    "aria-valuemax": duration,
    "aria-valuenow": Number(position.toFixed(2)),
    "aria-valuetext": stamp(position),
    ...seekHandlers,
  });
  return (
    <section
      className="arrangement mix-arrangement"
      ref={root}
      aria-label="All instruments"
    >
      <div className="section-top">
        <h2>
          Your instruments <span>{parts.length}</span>
        </h2>
        <div className="mix-transport">
          <button
            className="mix-play"
            aria-label={
              active ? "Pause all instruments" : "Play all instruments"
            }
            onClick={onPlay}
            disabled={busy}
          >
            {preparing && active ? "…" : active ? "Ⅱ" : "▶"}
          </button>
          <output aria-label="Mix playhead">
            {stamp(position)} / {stamp(duration)}
          </output>
          <span className="mix-caption">Rebuilt mix</span>
        </div>
        <div className="mix-zoom">
          <button
            aria-label="Zoom out tracks"
            title="Zoom out"
            onClick={() => zoom(time, 1.4)}
            disabled={span >= duration}
          >
            −
          </button>
          <input
            aria-label="Track zoom"
            type="range"
            min="0"
            max="100"
            step="0.1"
            value={
              duration <= 0.25
                ? 0
                : (1 - (span - 0.25) / (duration - 0.25)) * 100
            }
            onChange={(e) => {
              const next = Math.max(
                duration -
                  (Number(e.target.value) / 100) *
                    (duration - Math.min(0.25, duration)),
                Math.min(0.25, duration),
              );
              setView([clamp(time - next / 2, 0, duration - next), next]);
            }}
          />
          <button
            aria-label="Zoom in tracks"
            title="Zoom in"
            onClick={() => zoom(time, 0.7)}
            disabled={span <= Math.min(0.25, duration)}
          >
            +
          </button>
          <button onClick={() => setView([0, duration])}>Fit tracks</button>
        </div>
      </div>
      <div className="mix-ruler mix-grid">
        <span>INSTRUMENT · SOLO / MUTE</span>
        <div
          className="mix-lane mix-ticks"
          data-timeline
          {...sliderProps("Seek all instruments")}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <span key={t}>{stamp(start + t * span)}</span>
          ))}
          {head}
        </div>
      </div>
      <div className="mix-track-list">
        {parts.map((p, i) => (
          <div
            key={p.id}
            className={`mix-grid mix-track ${selected === p.id ? "active" : ""} ${audible.has(p.id) ? "" : "inaudible"}`}
            style={{ "--track": colors[i % colors.length] }}
          >
            <div className="mix-track-controls">
              <button
                className="mix-select"
                aria-label={`Edit ${p.name}`}
                aria-pressed={selected === p.id}
                disabled={busy}
                onClick={() => onSelect(p)}
              >
                <span className="track-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>
                  <strong>
                    {p.name}
                    {p.engine === "drum" && p.discovery?.needsReview
                      ? " · review"
                      : ""}
                  </strong>
                  <small>
                    {p.engine === "drum" ? "Hybrid drum" : p.patch.family} ·{" "}
                    {p.notes.length} {p.engine === "drum" ? "hits" : "notes"}
                  </small>
                </span>
              </button>
              <button
                className="mix-solo"
                aria-label={`Solo ${p.name}`}
                title="Solo (multiple solos allowed)"
                aria-pressed={solo.includes(p.id)}
                onClick={() => onToggle("solo", p.id)}
              >
                S
              </button>
              <button
                className="mix-mute"
                aria-label={`Mute ${p.name}`}
                title="Mute"
                aria-pressed={muted.includes(p.id)}
                onClick={() => onToggle("muted", p.id)}
              >
                M
              </button>
              <select
                className="mix-merge"
                aria-label={`Merge ${p.name} into`}
                title="Move every event into another track, keeping its sound"
                value=""
                disabled={busy}
                onChange={(e) =>
                  setMerge({ sourceId: p.id, targetId: e.target.value })
                }
              >
                <option value="">Merge into…</option>
                {parts
                  .filter(
                    (other) =>
                      other.id !== p.id &&
                      other.ownerProjectId === p.ownerProjectId &&
                      (other.engine === "drum") === (p.engine === "drum"),
                  )
                  .map((other) => (
                    <option key={other.id} value={other.id}>
                      → {other.name}
                    </option>
                  ))}
              </select>
            </div>
            <div
              className="mix-lane"
              data-timeline
              {...sliderProps(`Seek ${p.name}`)}
            >
              <Overview part={p} start={start} span={span} />
              {head}
            </div>
          </div>
        ))}
      </div>
      {merge && (
        <div
          className="mix-merge-review"
          role="region"
          aria-label="Merge instruments"
        >
          <p>
            Merge{" "}
            <strong>{parts.find((p) => p.id === merge.sourceId)?.name}</strong>{" "}
            into{" "}
            <strong>{parts.find((p) => p.id === merge.targetId)?.name}</strong>?
            All events will use the destination sound. The source row will be
            removed and the merged audio saved.
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              await onMerge(merge.sourceId, merge.targetId);
              setMerge(null);
            }}
          >
            {busy ? "Merging…" : "Merge tracks"}
          </button>
          <button disabled={busy} onClick={() => setMerge(null)}>
            Cancel merge
          </button>
        </div>
      )}
      <div className="mix-footer">
        <span>
          Click or drag tracks to seek · pinch to zoom · scroll horizontally to
          pan
        </span>
        <label>
          View position{" "}
          <input
            aria-label="Track view position"
            type="range"
            min="0"
            max={Math.max(0, duration - span)}
            step="0.01"
            value={start}
            disabled={span >= duration}
            onChange={(e) => setView([Number(e.target.value), span])}
          />
        </label>
      </div>
    </section>
  );
}
