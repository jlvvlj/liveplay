export type DrumParam = "tune" | "decay" | "transient" | "tone" | "noise" | "brightness" | "drive" | "gain" | "detail";
export type DrumModelParam =
  | "frequency"
  | "phase"
  | "sweep"
  | "sweepDecay"
  | "toneDecay"
  | "toneLevel"
  | "noiseLevel"
  | "noiseDecay"
  | "pan";
export type DrumPatchData = Partial<Record<DrumParam, number>> & {
  model?: Partial<Record<DrumModelParam, number>>;
  chokeGroup?: string;
};
export interface DrumAsset {
  channels: Float32Array[];
  sampleRate: number;
}

export const DRUM_PARAMS: Record<DrumParam, [number, number]>;
export function prepareDrum(data: DrumPatchData, asset: DrumAsset, sampleRate?: number): Float32Array[];
