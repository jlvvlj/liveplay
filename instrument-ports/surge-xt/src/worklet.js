// The AudioWorkletProcessor around the Surge XT engine (appended to the
// emscripten glue, which defines createSurgeXt).
//
// processorOptions: { wasm: WebAssembly.Module | ArrayBuffer, data: ArrayBuffer }
// (dist/surge-xt.wasm and dist/surge-xt-data.bin; dist/surge-xt.js fetches both).
//
// In:  {type:'noteOn', note, velocity, time} {type:'noteOff', note, time}
//      {type:'allOff'} {type:'param', key, value} {type:'preset', id}
// Out: {type:'ready', params:[{key,label,min,max,step,default,group}],
//                     presets:[{id,name,tag,params:{key:value}}]}
//      {type:'error', message} when the engine cannot start

const SXT_DATA_ROOT = '/surge';
const SXT_MAX_EVENTS = 4096;
const SXT_NOTE_ON = 1;
const SXT_NOTE_OFF = 2;

class SurgeXtProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = null;
    this.waiting = []; // param and preset messages that arrive before the engine is up

    // Timed notes, sorted by time; plain typed arrays so process() never allocates
    this.evTime = new Float64Array(SXT_MAX_EVENTS);
    this.evType = new Uint8Array(SXT_MAX_EVENTS);
    this.evNote = new Uint8Array(SXT_MAX_EVENTS);
    this.evVelocity = new Uint8Array(SXT_MAX_EVENTS);
    this.evCount = 0;

    this.port.onmessage = (event) => this.receive(event.data);
    const { wasm, data } = (options && options.processorOptions) || {};
    this.start(wasm, data).catch((error) => {
      this.port.postMessage({ type: 'error', message: String((error && error.stack) || error) });
    });
  }

  async start(wasm, data) {
    if (!wasm || !data) throw new Error('surge-xt: processorOptions.wasm and .data are required');
    const engine = await createSurgeXt({
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(wasm, imports).then((result) =>
          receive(result instanceof WebAssembly.Instance ? result : result.instance)
        );
        return {};
      },
      print() {},
      printErr() {},
    });
    unpackSurgeXtData(engine.FS, new Uint8Array(data));

    const root = engine.stringToNewUTF8(SXT_DATA_ROOT);
    const count = engine._sxt_init(sampleRate, root);
    engine._free(root);
    if (count < 0) throw new Error(`surge-xt: ${engine.UTF8ToString(engine._sxt_error())}`);
    const description = JSON.parse(engine.UTF8ToString(engine._sxt_describe()));
    // Each preset's parameter values, where they differ from the defaults (the
    // build writes them for every preset; its first pass runs with none)
    const values = JSON.parse(engine.FS.readFile(`${SXT_DATA_ROOT}/preset-values.json`, { encoding: 'utf8' }));
    for (const preset of description.presets) preset.params = values[preset.id] || {};

    this.blockSize = engine._sxt_block_size();
    this.leftPtr = engine._sxt_output_left();
    this.rightPtr = engine._sxt_output_right();
    this.position = this.blockSize; // samples of the current engine block already played
    this.engine = engine;
    this.views();

    this.paramIndex = new Map(description.params.map((p, i) => [p.key, i]));
    this.presetIndex = new Map(description.presets.map((p, i) => [p.id, i]));
    for (const message of this.waiting) this.receive(message);
    this.waiting = null;

    this.port.postMessage({ type: 'ready', params: description.params, presets: description.presets });
  }

  // Heap views onto the engine's output block (memory growth replaces the heap buffer)
  views() {
    const heap = this.engine.HEAPF32;
    this.heap = heap.buffer;
    this.left = new Float32Array(heap.buffer, this.leftPtr, this.blockSize);
    this.right = new Float32Array(heap.buffer, this.rightPtr, this.blockSize);
  }

  receive(message) {
    if (!message || typeof message.type !== 'string') return;
    if (!this.engine) {
      if (message.type === 'param' || message.type === 'preset') this.waiting.push(message);
      return;
    }
    const engine = this.engine;
    switch (message.type) {
      case 'noteOn': {
        const velocity = Math.max(1, Math.min(127, Math.round(message.velocity ?? 100)));
        this.schedule(message.time, SXT_NOTE_ON, message.note, velocity);
        break;
      }
      case 'noteOff':
        this.schedule(message.time, SXT_NOTE_OFF, message.note, 0);
        break;
      case 'allOff':
        this.evCount = 0;
        engine._sxt_all_off();
        break;
      case 'param': {
        const index = this.paramIndex.get(message.key);
        if (index !== undefined && Number.isFinite(message.value)) engine._sxt_set_param(index, message.value);
        break;
      }
      case 'preset': {
        const index = this.presetIndex.get(message.id);
        if (index !== undefined) {
          this.evCount = 0;
          engine._sxt_load_preset(index);
        }
        break;
      }
    }
    if (engine.HEAPF32.buffer !== this.heap) this.views();
  }

  schedule(time, type, note, velocity) {
    if (!Number.isInteger(note) || note < 0 || note > 127) return;
    if (this.evCount === SXT_MAX_EVENTS) return;
    const t = Number.isFinite(time) ? time : 0;
    let i = this.evCount++;
    // Insert in time order; notes at the same time keep their arrival order
    while (i > 0 && this.evTime[i - 1] > t) {
      this.evTime[i] = this.evTime[i - 1];
      this.evType[i] = this.evType[i - 1];
      this.evNote[i] = this.evNote[i - 1];
      this.evVelocity[i] = this.evVelocity[i - 1];
      i--;
    }
    this.evTime[i] = t;
    this.evType[i] = type;
    this.evNote[i] = note;
    this.evVelocity[i] = velocity;
  }

  // Notes due by the engine block that starts at `frame` of this render quantum:
  // each note goes to the block edge nearest its time
  dispatch(frame) {
    const engine = this.engine;
    const due = currentTime + (frame + this.blockSize / 2) / sampleRate;
    let n = 0;
    while (n < this.evCount && this.evTime[n] < due) {
      if (this.evType[n] === SXT_NOTE_ON) engine._sxt_note_on(this.evNote[n], this.evVelocity[n]);
      else engine._sxt_note_off(this.evNote[n]);
      n++;
    }
    if (n > 0) {
      this.evTime.copyWithin(0, n, this.evCount);
      this.evType.copyWithin(0, n, this.evCount);
      this.evNote.copyWithin(0, n, this.evCount);
      this.evVelocity.copyWithin(0, n, this.evCount);
      this.evCount -= n;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!this.engine || !output || output.length === 0) return true;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const frames = outL.length;
    const size = this.blockSize;
    let i = 0;
    while (i < frames) {
      if (this.position === size) {
        this.dispatch(i);
        this.engine._sxt_render();
        if (this.engine.HEAPF32.buffer !== this.heap) this.views();
        this.position = 0;
      }
      const left = this.left;
      const right = this.right;
      let p = this.position;
      const end = Math.min(frames, i + size - p);
      for (; i < end; i++, p++) {
        outL[i] = left[p];
        if (outR) outR[i] = right[p];
      }
      this.position = p;
    }
    return true;
  }
}

// Writes the data bundle's files into the engine's in-memory filesystem, without copies
function unpackSurgeXtData(FS, bytes) {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (magic !== 'SXTD' || view.getUint32(4, true) !== 1) throw new Error('surge-xt: not a surge-xt-data.bin bundle');
  const indexLength = view.getUint32(8, true);
  let json = '';
  for (let i = 12; i < 12 + indexLength; i++) json += String.fromCharCode(bytes[i]);
  const index = JSON.parse(decodeURIComponent(escape(json)));
  let offset = 12 + indexLength;
  const made = new Set();
  for (const [path, size] of index) {
    const full = `${SXT_DATA_ROOT}/${path}`;
    const slash = full.lastIndexOf('/');
    const dir = full.slice(0, slash);
    if (!made.has(dir)) {
      FS.mkdirTree(dir);
      made.add(dir);
    }
    FS.createDataFile(dir, full.slice(slash + 1), bytes.subarray(offset, offset + size), true, false, true);
    offset += size;
  }
}

registerProcessor('melodics-surge-xt', SurgeXtProcessor);
