export type StemName = 'drums' | 'bass' | 'vocals' | 'other';
export type StemId = StemName | string;

export type SongStatus = 'imported' | 'queued' | 'separating' | 'ready' | 'error';

export type SeparationStage = 'queued' | 'provisioning' | 'loading-model' | 'separating' | 'exporting';

export interface SeparationProgress {
  stage: SeparationStage;
  progress: number; // 0..1, meaningful during 'separating'
}

export interface Song {
  id: string;
  title: string;
  sourcePath: string;
  status: SongStatus;
  error: string | null;
  duration: number | null;
  stems: Record<StemName, string> | null; // paths relative to /audio/
  createdAt: string;
  progress: SeparationProgress | null; // live, only while a job is queued/running
}

export const STEM_NAMES: StemName[] = ['drums', 'bass', 'vocals', 'other'];

export const STEM_LABELS: Record<StemName, string> = {
  drums: 'Drums',
  bass: 'Bass',
  vocals: 'Vocals',
  other: 'Other',
};

export interface MergedStem {
  id: string;
  stems: StemName[];
  label: string;
  path: string; // relative to /audio/
}

export function getStemLabel(stem: StemId): string {
  if (stem in STEM_LABELS) {
    return STEM_LABELS[stem as StemName];
  }
  if (stem.startsWith('merged-')) {
    return stem
      .replace(/^merged-/, '')
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' + ');
  }
  return stem;
}
