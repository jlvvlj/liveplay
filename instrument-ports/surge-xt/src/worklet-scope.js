// What the emscripten runtime needs from its host, written for an
// AudioWorkletGlobalScope, which has no `performance` and no `crypto`.
addToLibrary({
  // std::chrono clocks (the engine's CPU-load figures)
  emscripten_get_now: () => Date.now(),
  // std::random_device (seeds for the engine's noise and random modulators)
  $initRandomFill: () => (view) => {
    for (let i = 0; i < view.length; i++) view[i] = (Math.random() * 256) | 0;
    return 0;
  },
});
