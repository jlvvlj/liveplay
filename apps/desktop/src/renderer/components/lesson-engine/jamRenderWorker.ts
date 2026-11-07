// Starts a worker that renders Jam sounds and backing-track parts (see
// jamRender.worker.ts and jamRenderer.ts)
export const startJamRenderWorker = (): Worker =>
  new Worker(new URL('./jamRender.worker.ts', import.meta.url), { type: 'module' });
