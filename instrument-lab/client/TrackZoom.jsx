import React from "react";
import { clamp, zoomWindow } from "./timeline.mjs";
import "./track-zoom.css";

// Zoom for a timeline of tracks (Instrument Lab's arrangement, the Jam's
// grid): zoom out, a slider from the whole `duration` to `minSpan`, zoom in,
// and fit. `view` is [start, span]; zooming keeps `focus` where it is.
export default function TrackZoom({ view, duration, focus, minSpan = 0.25, onView }) {
  const [, span] = view;
  const least = Math.min(minSpan, duration);
  return (
    <div className="mix-zoom">
      <button
        aria-label="Zoom out tracks"
        title="Zoom out"
        onClick={() => onView(zoomWindow(view[0], span, duration, focus, 1.4, minSpan))}
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
        value={duration <= least ? 0 : (1 - (span - least) / (duration - least)) * 100}
        onChange={(e) => {
          const next = Math.max(duration - (Number(e.target.value) / 100) * (duration - least), least);
          onView([clamp(focus - next / 2, 0, duration - next), next]);
        }}
      />
      <button
        aria-label="Zoom in tracks"
        title="Zoom in"
        onClick={() => onView(zoomWindow(view[0], span, duration, focus, 0.7, minSpan))}
        disabled={span <= least}
      >
        +
      </button>
      <button onClick={() => onView([0, duration])}>Fit tracks</button>
    </div>
  );
}
