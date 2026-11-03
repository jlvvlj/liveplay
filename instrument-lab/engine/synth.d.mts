export type SynthFamily = "sine" | "triangle" | "saw" | "square" | "pulse" | "fm";
export type SynthParam =
  | "brightness"
  | "body"
  | "odd"
  | "fm"
  | "ratio"
  | "attack"
  | "decay"
  | "sustain"
  | "release"
  | "detune"
  | "gain";
export type SynthPatch = { family: SynthFamily } & Record<SynthParam, number>;
export interface SynthNote {
  pitch: number;
  start: number;
  end: number;
  velocity?: number;
}

export const VERSION: number;
export const DEFAULT_PATCH: Readonly<SynthPatch>;
export const PARAMS: Record<SynthParam, [number, number]>;
export const FAMILIES: SynthFamily[];
export function hz(pitch: number): number;
export function patchData(input?: Partial<SynthPatch>): SynthPatch;
export function renderNotes(
  patch: Partial<SynthPatch>,
  notes: SynthNote[],
  duration: number,
  sampleRate?: number,
): Float32Array;
export function encodeWav(audio: Float32Array, sampleRate?: number): ArrayBuffer;
export function makeTable(patch: Partial<SynthPatch>, pitch: number, sampleRate: number): Float32Array;
export function envelope(patch: SynthPatch, time: number, gate?: number): number;
