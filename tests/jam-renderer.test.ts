import type * as JamRenderer from '../apps/desktop/src/renderer/components/lesson-engine/jamRenderer.ts';
import { jamTrackByFile, jamTrackParts } from '../apps/desktop/src/renderer/components/lesson-engine/jamTracks';

// The Jam renderer's worker pool (jamRenderer.ts), with stand-in workers
type Posted = { id: number; [key: string]: unknown };
class MockWorker {
  static all: MockWorker[] = [];
  posted: Posted[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() {
    MockWorker.all.push(this);
  }
  postMessage(message: Posted) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: object) {
    this.onmessage?.({ data });
  }
  fail(message = '') {
    this.onerror?.({ message, preventDefault: () => {} });
  }
}
jest.mock('../apps/desktop/src/renderer/components/lesson-engine/jamRenderWorker', () => ({
  startJamRenderWorker: () => new MockWorker(),
}));

// What each running worker was sent and has not answered yet
const unanswered = () =>
  MockWorker.all
    .filter((worker) => !worker.terminated)
    .flatMap((worker) => worker.posted.map((message) => ({ worker, message })))
    .filter(({ message }) => !answered.has(message.id));
const answered = new Set<number>();
const answer = (worker: MockWorker, data: object & { id: number }) => {
  answered.add(data.id);
  worker.reply(data);
};
const audio = (value: number, length = 4) => ({ channels: [new Float32Array(length).fill(value), new Float32Array(length).fill(value)], sampleRate: 44100 });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let renderer: typeof JamRenderer;
beforeAll(async () => {
  // A pool of three workers
  Object.defineProperty(window.navigator, 'hardwareConcurrency', { value: 4, configurable: true });
  renderer = await import('../apps/desktop/src/renderer/components/lesson-engine/jamRenderer.ts');
});

describe('jamRenderer', () => {
  it('fails what was sent to a worker that could not load, and starts another in its place', async () => {
    const rendering = renderer.renderJamSound({ patch: {} } as never, [60]);
    expect(MockWorker.all).toHaveLength(3);
    const [{ worker }] = unanswered();
    worker.fail();
    await expect(rendering).rejects.toThrow('The Jam render worker failed: it could not be loaded');
    expect(worker.terminated).toBe(true);

    const next = renderer.renderJamSound({ patch: {} } as never, [60]);
    expect(MockWorker.all).toHaveLength(4);
    const sent = unanswered();
    expect(sent).toHaveLength(1);
    sent[0].worker.fail('SyntaxError: bad chunk');
    await expect(next).rejects.toThrow('The Jam render worker failed: SyntaxError: bad chunk');
  });

  it("renders a part's pieces dry and adds the track's room to their sum once", async () => {
    const track = jamTrackByFile('night_jazz.wav')!;
    const part = track.drums.length + 1; // Rhodes, many distinct notes
    const rendering = renderer.renderJamBackingPart(track.file, part, jamTrackParts(track)[part].notes);
    const pieces = unanswered();
    expect(pieces.length).toBe(3);
    expect(new Set(pieces.map(({ worker }) => worker)).size).toBe(3);
    for (const { worker, message } of pieces) {
      expect(message).toMatchObject({ trackFile: track.file, part, dry: true });
      answer(worker, { id: message.id, part: audio(1) });
    }
    await flush();
    const [effects, ...more] = unanswered();
    expect(more).toHaveLength(0);
    expect(effects.message).toMatchObject({ trackFile: track.file });
    expect((effects.message.effects as Float32Array[]).map((channel) => Array.from(channel))).toEqual([
      [3, 3, 3, 3],
      [3, 3, 3, 3],
    ]);
    answer(effects.worker, { id: effects.message.id, part: audio(5) });
    expect((await rendering).channels[0][0]).toBe(5);
  });

  it("renders a track with no echo or room in pieces that are only added up", async () => {
    const track = jamTrackByFile('chip_run.wav')!;
    expect(track.room ?? track.echo).toBeUndefined();
    const part = track.drums.length;
    const rendering = renderer.renderJamBackingPart(track.file, part, jamTrackParts(track)[part].notes);
    const pieces = unanswered();
    expect(pieces.length).toBeGreaterThan(1);
    for (const { worker, message } of pieces) {
      expect(message.dry).toBeUndefined();
      answer(worker, { id: message.id, part: audio(1) });
    }
    expect((await rendering).channels[0][0]).toBe(pieces.length);
    expect(unanswered()).toHaveLength(0);
  });

  it('sends the URLs of the recorded sounds it needs', async () => {
    const rendering = renderer.renderJamSound({ sample: [{ file: 'softer/keys-60.wav', root: 60 }] } as never, [60]);
    const [{ worker, message }] = unanswered();
    expect(message.urls).toEqual({ 'softer/keys-60.wav': '/softer/keys-60.wav' });
    answer(worker, { id: message.id, clips: {} });
    await expect(rendering).resolves.toEqual({});
  });
});
