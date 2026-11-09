import { JAM_RECORDED_TOP_DB, jamRecordedNotesDb } from '../apps/desktop/src/renderer/components/lesson-engine/jamAbletonImport';

const peakAt = (recordingPeak: number, volume: number) => recordingPeak * 10 ** (jamRecordedNotesDb(volume, 0.75, recordingPeak) / 20);

describe('jamRecordedNotesDb', () => {
  it('brings a track to the backing\'s peak at the usual volume, however quiet its recording', () => {
    const backingPeak = 10 ** (JAM_RECORDED_TOP_DB / 20);
    for (const recordingPeak of [1, 0.54, 0.107]) expect(peakAt(recordingPeak, 0.75)).toBeCloseTo(backingPeak);
  });

  it('follows the volume, silent at 0', () => {
    expect(jamRecordedNotesDb(1, 0.75, 1) - jamRecordedNotesDb(0.75, 0.75, 1)).toBeCloseTo(5);
    expect(jamRecordedNotesDb(0, 0.75, 1)).toBe(-Infinity);
  });

  it('does not lift a silent recording without limit', () => {
    expect(jamRecordedNotesDb(0.75, 0.75, 0)).toBeCloseTo(JAM_RECORDED_TOP_DB + 40);
  });
});
