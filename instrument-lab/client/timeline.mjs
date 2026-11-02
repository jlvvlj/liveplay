export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
export function zoomWindow(start, span, duration, focus, factor) {
  const nextSpan = clamp(span * factor, Math.min(0.25, duration), duration);
  const ratio = clamp((focus - start) / span, 0, 1);
  return [clamp(focus - ratio * nextSpan, 0, duration - nextSpan), nextSpan];
}
export function audibleIds(parts, muted = [], solo = []) {
  const solos = new Set(solo),
    mutes = new Set(muted);
  return new Set(
    parts
      .filter((p) => !mutes.has(p.id) && (!solos.size || solos.has(p.id)))
      .map((p) => p.id),
  );
}
