// A Worker that reads Vital presets for the worklet (melodics-vital): its own
// instance of vital.wasm loads each preset's file, which takes up to half a
// second, and packs what it built (the settings, the rendered wavetables, the
// prepared sample), which the worklet copies in within a few milliseconds.
// Reading files here keeps that work off the audio thread.
//
// In:  {type:'start', wasm: WebAssembly.Module, sampleRate}
//      {type:'pack', id, data: ArrayBuffer}        a preset's .vital file
// Out: {type:'packed', id, data: ArrayBuffer}      for the worklet's preset message
//      {type:'error', id, message}

let wasm = null;
let memory = null;
let started = null;

function imports() {
  const view = () => new DataView(memory.buffer);
  return {
    wasi_snapshot_preview1: {
      fd_write(fd, iov, iovcnt, written) {
        let total = 0;
        for (let i = 0; i < iovcnt; i++) total += view().getUint32(iov + i * 8 + 4, true);
        view().setUint32(written, total, true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 70,
      fd_read: () => 8,
      fd_fdstat_get: () => 8,
      environ_sizes_get(count, size) {
        view().setUint32(count, 0, true);
        view().setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      args_sizes_get(count, size) {
        view().setUint32(count, 0, true);
        view().setUint32(size, 0, true);
        return 0;
      },
      args_get: () => 0,
      clock_time_get(id, precision, out) {
        view().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
        return 0;
      },
      random_get(buffer, length) {
        crypto.getRandomValues(new Uint8Array(memory.buffer, buffer, length));
        return 0;
      },
      proc_exit(code) {
        throw new Error(`vital loader exited (${code})`);
      },
    },
    env: { emscripten_notify_memory_growth() {} },
  };
}

async function start(module, sampleRate) {
  const instance = await WebAssembly.instantiate(module, imports());
  wasm = instance.exports;
  memory = wasm.memory;
  if (wasm._initialize) wasm._initialize();
  wasm.mp_init(sampleRate);
}

function pack(data) {
  const bytes = new Uint8Array(data);
  const at = wasm.mp_preset_buffer(bytes.length);
  new Uint8Array(memory.buffer, at, bytes.length).set(bytes);
  wasm.mp_load_preset(0);
  if (wasm.mp_preset_error()) throw new Error('the preset could not be read');
  const size = wasm.mp_pack_preset_size();
  return new Uint8Array(memory.buffer, wasm.mp_pack_preset(), size).slice().buffer;
}

self.onmessage = async ({ data: message }) => {
  if (message.type === 'start') {
    started = start(message.wasm, message.sampleRate);
    return;
  }
  if (message.type !== 'pack') return;
  try {
    if (!started) throw new Error('the loader was not started');
    await started;
    const packed = pack(message.data);
    self.postMessage({ type: 'packed', id: message.id, data: packed }, [packed]);
  } catch (error) {
    self.postMessage({ type: 'error', id: message.id, message: String((error && error.message) || error) });
  }
};
