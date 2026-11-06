export function clamp(value: number, min: number, max: number): number;
export function zoomWindow(
  start: number,
  span: number,
  duration: number,
  focus: number,
  factor: number,
  minSpan?: number,
): [number, number];
export function audibleIds<T extends { id: string }>(parts: T[], muted?: string[], solo?: string[]): Set<string>;
