// AudioWorkletProcessor "__PROCESSOR__" running __NAME__.wasm.
//
// Create the node with the module's bytes (or a compiled WebAssembly.Module):
//   new AudioWorkletNode(context, '__PROCESSOR__', {
//     numberOfInputs: __INPUTS__, outputChannelCount: [2],
//     processorOptions: { wasm: await (await fetch('__NAME__.wasm')).arrayBuffer() },
//   })
//
// Messages in:
//   {type:'noteOn', note, velocity, time}   velocity 1-127, time in context seconds
//   {type:'noteOff', note, time}
//   {type:'allOff'}                          stops every voice, drops pending notes
//   {type:'param', key, value}
//   {type:'preset', id}
// Messages out:
//   {type:'ready', params:[{key,label,min,max,step,default}], presets:[{id,name}]}
//   {type:'presetLoaded', id, values:{key: value}}   after a preset message
//   {type:'error', message}                          the module failed to start
//
// Notes are applied at their own sample inside the block. Nothing is
// allocated in process().

const PROCESSOR = '__PROCESSOR__';
const IS_EFFECT = __EFFECT__;
const QUEUE_SIZE = 4096;
const NOTE_ON = 1;
const NOTE_OFF = 2;

// AudioWorkletGlobalScope has no TextDecoder
function utf8(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let code = b;
    if (b >= 0xf0) code = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (b >= 0xe0) code = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (b >= 0xc0) code = ((b & 31) << 6) | (bytes[i++] & 63);
    text += String.fromCodePoint(code);
  }
  return text;
}

class MelodicsPort extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.wasm = null;
    this.memory = null;
    this.heap = null;
    this.outL = null;
    this.outR = null;
    this.inL = null;
    this.inR = null;
    this.maxFrames = 0;
    this.paramIndex = new Map();
    this.presetIndex = new Map();
    this.params = [];
    // Pending notes, kept in time order
    this.qTime = new Float64Array(QUEUE_SIZE);
    this.qKind = new Uint8Array(QUEUE_SIZE);
    this.qNote = new Uint8Array(QUEUE_SIZE);
    this.qVelocity = new Uint8Array(QUEUE_SIZE);
    this.qCount = 0;
    this.port.onmessage = (event) => this.receive(event.data);
    const source = options && options.processorOptions && options.processorOptions.wasm;
    if (!source) {
      this.port.postMessage({ type: 'error', message: 'processorOptions.wasm is missing' });
      return;
    }
    this.start(source).catch((error) => {
      this.port.postMessage({ type: 'error', message: String((error && error.message) || error) });
    });
  }

  async start(source) {
    const self = this;
    const memoryView = () => new DataView(self.memory.buffer);
    const wasi = {
      fd_write(fd, iov, iovcnt, written) {
        // Upstream code may print; the bytes are counted and dropped
        const view = memoryView();
        let total = 0;
        for (let i = 0; i < iovcnt; i++) total += view.getUint32(iov + i * 8 + 4, true);
        view.setUint32(written, total, true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 70,
      fd_read: () => 8,
      fd_fdstat_get: () => 8,
      environ_sizes_get(count, size) {
        const view = memoryView();
        view.setUint32(count, 0, true);
        view.setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      args_sizes_get(count, size) {
        const view = memoryView();
        view.setUint32(count, 0, true);
        view.setUint32(size, 0, true);
        return 0;
      },
      args_get: () => 0,
      clock_time_get(id, precision, out) {
        memoryView().setBigUint64(out, BigInt(Math.round(currentTime * 1e9)), true);
        return 0;
      },
      random_get(buffer, length) {
        const bytes = new Uint8Array(self.memory.buffer, buffer, length);
        for (let i = 0; i < length; i++) bytes[i] = (Math.random() * 256) | 0;
        return 0;
      },
      proc_exit(code) {
        throw new Error(`${PROCESSOR} exited (${code})`);
      },
    };
    const imports = {
      wasi_snapshot_preview1: wasi,
      env: {
        emscripten_notify_memory_growth() {
          self.heap = null;
        },
      },
    };
    const result = await WebAssembly.instantiate(source, imports);
    const instance = result.instance || result;
    const wasm = instance.exports;
    this.memory = wasm.memory;
    if (wasm._initialize) wasm._initialize();
    wasm.mp_init(sampleRate);
    this.maxFrames = wasm.mp_max_frames();
    const description = JSON.parse(
      utf8(new Uint8Array(this.memory.buffer, wasm.mp_describe(), wasm.mp_describe_length()))
    );
    this.params = description.params;
    description.params.forEach((param, index) => this.paramIndex.set(param.key, index));
    description.presets.forEach((preset, index) => this.presetIndex.set(String(preset.id), index));
    this.wasm = wasm;
    this.views();
    this.port.postMessage({ type: 'ready', params: description.params, presets: description.presets });
  }

  views() {
    const wasm = this.wasm;
    const buffer = this.memory.buffer;
    this.heap = buffer;
    this.outL = new Float32Array(buffer, wasm.mp_output(0), this.maxFrames);
    this.outR = new Float32Array(buffer, wasm.mp_output(1), this.maxFrames);
    this.inL = new Float32Array(buffer, wasm.mp_input(0), this.maxFrames);
    this.inR = new Float32Array(buffer, wasm.mp_input(1), this.maxFrames);
  }

  receive(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'noteOn':
        this.enqueue(NOTE_ON, message.note, message.velocity, message.time);
        break;
      case 'noteOff':
        this.enqueue(NOTE_OFF, message.note, 0, message.time);
        break;
      case 'allOff':
        this.qCount = 0;
        if (this.wasm) this.wasm.mp_all_off();
        break;
      case 'param': {
        const index = this.paramIndex.get(message.key);
        if (this.wasm && index !== undefined) this.wasm.mp_set_param(index, Number(message.value));
        break;
      }
      case 'preset': {
        const index = this.presetIndex.get(String(message.id));
        if (!this.wasm || index === undefined) break;
        this.wasm.mp_load_preset(index);
        const values = {};
        this.params.forEach((param, i) => {
          values[param.key] = this.wasm.mp_get_param(i);
        });
        this.port.postMessage({ type: 'presetLoaded', id: message.id, values });
        break;
      }
    }
  }

  enqueue(kind, note, velocity, time) {
    note = Math.round(Number(note));
    if (!(note >= 0 && note <= 127)) return;
    if (this.qCount >= QUEUE_SIZE) return;
    const t = Number.isFinite(time) ? time : 0;
    // Insert after every event at or before t, keeping arrival order for ties
    let i = this.qCount;
    while (i > 0 && this.qTime[i - 1] > t) {
      this.qTime[i] = this.qTime[i - 1];
      this.qKind[i] = this.qKind[i - 1];
      this.qNote[i] = this.qNote[i - 1];
      this.qVelocity[i] = this.qVelocity[i - 1];
      i--;
    }
    this.qTime[i] = t;
    this.qKind[i] = kind;
    this.qNote[i] = note;
    this.qVelocity[i] = Math.max(1, Math.min(127, Math.round(Number(velocity) || 100)));
    this.qCount++;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const wasm = this.wasm;
    if (!wasm || !output || output.length === 0) return true;
    if (this.heap !== this.memory.buffer || this.outL.byteLength === 0) this.views();
    const frames = output[0].length;
    const blockStart = currentTime;
    let done = 0;
    while (done < frames) {
      const chunk = Math.min(frames - done, this.maxFrames);
      const chunkStart = blockStart + done / sampleRate;
      const chunkEnd = chunkStart + chunk / sampleRate;
      if (IS_EFFECT) {
        const input = inputs[0];
        const left = input && input.length > 0 ? input[0] : null;
        const right = input && input.length > 1 ? input[1] : left;
        for (let i = 0; i < chunk; i++) {
          this.inL[i] = left ? left[done + i] : 0;
          this.inR[i] = right ? right[done + i] : 0;
        }
      }
      let position = 0;
      let used = 0;
      while (used < this.qCount && this.qTime[used] < chunkEnd) {
        let at = Math.round((this.qTime[used] - chunkStart) * sampleRate);
        if (at < 0) at = 0;
        if (at > chunk) at = chunk;
        if (at > position) {
          wasm.mp_render(position, at - position);
          position = at;
        }
        if (this.qKind[used] === NOTE_ON) wasm.mp_note_on(this.qNote[used], this.qVelocity[used]);
        else wasm.mp_note_off(this.qNote[used]);
        used++;
      }
      if (position < chunk) wasm.mp_render(position, chunk - position);
      if (used > 0) {
        this.qTime.copyWithin(0, used, this.qCount);
        this.qKind.copyWithin(0, used, this.qCount);
        this.qNote.copyWithin(0, used, this.qCount);
        this.qVelocity.copyWithin(0, used, this.qCount);
        this.qCount -= used;
      }
      if (this.heap !== this.memory.buffer) this.views();
      const left = output[0];
      const right = output.length > 1 ? output[1] : null;
      for (let i = 0; i < chunk; i++) {
        left[done + i] = this.outL[i];
        if (right) right[done + i] = this.outR[i];
      }
      done += chunk;
    }
    return true;
  }
}

registerProcessor(PROCESSOR, MelodicsPort);
