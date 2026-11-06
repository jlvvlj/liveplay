// Stand-in for instrument-lab/client/timeline.mjs (a plain ES module Jest does
// not transform): the whole view, unchanged
export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
export const zoomWindow = (start: number, span: number): [number, number] => [start, span];
