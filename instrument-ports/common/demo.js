// The demo page every port shares: loads a port's worklet, plays it from the
// computer keyboard or the on-screen keys, its parameters as sliders and its
// presets as a menu.
//
// demo({ title, instruments: [{ name, label, effect?, source?, presets?, loader? }] })
//   name: the dist/<name>.wasm and dist/<name>.worklet.js to load
//   effect: true for an audio effect; it is played through by `source`
//   presets, loader: for a port whose presets are files (Vital), where each is
//     in dist/ ({id} for its id) and the Worker that reads one for the worklet

const KEYS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p', ';', "'"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const LOW = 48;
const SPAN = 25;

const el = (tag, className, parent) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
};

const wasmCache = new Map();
const wasmBytes = new Map();

// A preset message, with the preset's file read by the port's loader when its
// presets are files
const loaders = new Map();
let requests = 0;
async function presetMessage(context, def, id) {
  if (!def.presets) return { message: { type: 'preset', id } };
  if (!loaders.has(def.name)) {
    const worker = new Worker(`dist/${def.loader}`);
    worker.postMessage({ type: 'start', wasm: await WebAssembly.compile(wasmBytes.get(def.name)), sampleRate: context.sampleRate });
    loaders.set(def.name, worker);
  }
  const worker = loaders.get(def.name);
  const response = await fetch(`dist/${def.presets.replace('{id}', id)}`);
  if (!response.ok) throw new Error(`${def.presets.replace('{id}', id)}: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const request = ++requests;
  const answer = await new Promise((resolve) => {
    const listen = ({ data }) => {
      if (data.id !== request) return;
      worker.removeEventListener('message', listen);
      resolve(data);
    };
    worker.addEventListener('message', listen);
    worker.postMessage({ type: 'pack', id: request, data: bytes }, [bytes]);
  });
  if (answer.type !== 'packed') throw new Error(answer.message);
  return { message: { type: 'preset', id, data: answer.data }, transfer: [answer.data] };
}
async function sendPreset(context, instrument, id) {
  const { message, transfer } = await presetMessage(context, instrument, id);
  instrument.node.port.postMessage(message, transfer || []);
}
async function loadNode(context, name, effect) {
  if (!wasmCache.has(name)) {
    wasmCache.set(
      name,
      Promise.all([
        context.audioWorklet.addModule(`dist/${name}.worklet.js`),
        fetch(`dist/${name}.wasm`).then((r) => {
          if (!r.ok) throw new Error(`dist/${name}.wasm: ${r.status}`);
          return r.arrayBuffer();
        }),
      ]).then(([, bytes]) => bytes)
    );
  }
  const bytes = await wasmCache.get(name);
  wasmBytes.set(name, bytes);
  const node = new AudioWorkletNode(context, `melodics-${name}`, {
    numberOfInputs: effect ? 1 : 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { wasm: bytes.slice(0) },
  });
  const ready = await new Promise((resolve, reject) => {
    node.port.onmessage = (event) => {
      if (event.data.type === 'ready') resolve(event.data);
      if (event.data.type === 'error') reject(new Error(event.data.message));
    };
  });
  return { node, ready };
}

// A menu that is not the browser's own: a button opening a filterable list
function menu(parent, onPick) {
  const root = el('div', 'menu', parent);
  const button = el('button', 'menu-button', root);
  const label = el('span', 'menu-label', button);
  el('span', 'menu-caret', button).innerHTML =
    '<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const pop = el('div', 'menu-pop', root);
  const filter = el('input', 'menu-filter', pop);
  filter.type = 'text';
  filter.placeholder = 'Filter';
  const list = el('div', 'menu-list', pop);
  let items = [];
  let current = -1;
  const close = () => root.classList.remove('open');
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    list.textContent = '';
    items.forEach((item, i) => {
      if (q && !item.toLowerCase().includes(q)) return;
      const row = el('button', 'menu-item' + (i === current ? ' current' : ''), list);
      row.textContent = item;
      row.onclick = () => {
        close();
        api.set(i);
        onPick(i);
      };
    });
  };
  button.onclick = (event) => {
    event.stopPropagation();
    const open = !root.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
    if (open) {
      root.classList.add('open');
      filter.value = '';
      render();
      filter.style.display = items.length > 12 ? '' : 'none';
      if (items.length > 12) filter.focus();
      const at = list.querySelector('.current');
      if (at) at.scrollIntoView({ block: 'center' });
    }
  };
  pop.addEventListener('pointerdown', (event) => event.stopPropagation());
  filter.addEventListener('input', render);
  filter.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') close();
    if (event.key === 'Enter') list.querySelector('.menu-item')?.click();
  });
  document.addEventListener('pointerdown', close);
  const api = {
    root,
    setItems(next) {
      items = next;
    },
    set(i) {
      current = i;
      label.textContent = items[i] ?? '';
    },
    get index() {
      return current;
    },
    get count() {
      return items.length;
    },
  };
  return api;
}

function formatValue(spec, value) {
  if (spec.options) return spec.options[Math.round(value)] ?? '';
  const decimals = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : spec.step >= 0.01 ? 2 : 3;
  return Number(value).toFixed(decimals);
}

export function demo({ title, instruments }) {
  document.title = title;
  const page = el('div', 'page', document.body);
  const header = el('header', 'bar', page);
  el('h1', '', header).textContent = title;
  const tabs = el('div', 'tabs', header);
  const presetRow = el('div', 'preset-row', header);
  const prev = el('button', 'icon-button', presetRow);
  prev.textContent = '‹';
  prev.setAttribute('aria-label', 'Previous preset');
  const presetMenu = menu(presetRow, (i) => choosePreset(i));
  const next = el('button', 'icon-button', presetRow);
  next.textContent = '›';
  next.setAttribute('aria-label', 'Next preset');
  const panel = el('main', 'params', page);
  const footer = el('footer', 'keys-area', page);
  const octaveBox = el('div', 'octave', footer);
  const down = el('button', 'icon-button', octaveBox);
  down.textContent = '−';
  down.setAttribute('aria-label', 'Octave down');
  const octaveLabel = el('span', 'octave-label', octaveBox);
  const up = el('button', 'icon-button', octaveBox);
  up.textContent = '+';
  up.setAttribute('aria-label', 'Octave up');
  const keyboard = el('div', 'keyboard', footer);
  const status = el('div', 'status', page);

  const context = new AudioContext({ latencyHint: 'interactive' });
  const resume = () => context.state !== 'running' && context.resume();
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);

  let octave = 0;
  let active = null; // { node, ready, sliders, spec }
  let source = null; // the instrument an effect is played through
  const loaded = new Map();
  const held = new Map();
  const keyNodes = [];

  const target = () => (active && active.effect ? source : active);
  const noteOn = (note) => {
    const t = target();
    if (!t || held.has(note)) return;
    held.set(note, t);
    t.node.port.postMessage({ type: 'noteOn', note, velocity: 100, time: context.currentTime });
    if (active.effect) active.node.port.postMessage({ type: 'noteOn', note, velocity: 100, time: context.currentTime });
    keyNodes[note - LOW - octave * 12]?.classList.add('down');
  };
  const noteOff = (note) => {
    const t = held.get(note);
    if (!t) return;
    held.delete(note);
    t.node.port.postMessage({ type: 'noteOff', note, time: context.currentTime });
    if (active.effect) active.node.port.postMessage({ type: 'noteOff', note, time: context.currentTime });
    keyNodes[note - LOW - octave * 12]?.classList.remove('down');
  };
  const allOff = () => {
    for (const note of [...held.keys()]) noteOff(note);
  };

  for (let i = 0; i < SPAN; i++) {
    const key = el('div', 'key ' + (BLACK.has(i % 12) ? 'black' : 'white'), keyboard);
    key.dataset.offset = String(i);
    keyNodes.push(key);
  }
  // Black keys sit over the gap between their white neighbours
  const layoutKeys = () => {
    let white = 0;
    const whites = keyNodes.filter((k) => k.classList.contains('white')).length;
    keyNodes.forEach((key) => {
      if (key.classList.contains('white')) {
        key.style.left = `${(white / whites) * 100}%`;
        key.style.width = `${100 / whites}%`;
        white++;
      } else {
        key.style.left = `${(white / whites) * 100 - 100 / whites / 3}%`;
        key.style.width = `${(100 / whites) * 0.66}%`;
      }
    });
  };
  layoutKeys();
  let pointerNote = null;
  keyboard.addEventListener('pointerdown', (event) => {
    const key = event.target.closest('.key');
    if (!key) return;
    keyboard.setPointerCapture(event.pointerId);
    pointerNote = LOW + octave * 12 + Number(key.dataset.offset);
    noteOn(pointerNote);
  });
  keyboard.addEventListener('pointermove', (event) => {
    if (pointerNote === null) return;
    const key = document.elementFromPoint(event.clientX, event.clientY)?.closest('.key');
    if (!key) return;
    const note = LOW + octave * 12 + Number(key.dataset.offset);
    if (note !== pointerNote) {
      noteOff(pointerNote);
      pointerNote = note;
      noteOn(note);
    }
  });
  const release = () => {
    if (pointerNote !== null) noteOff(pointerNote);
    pointerNote = null;
  };
  keyboard.addEventListener('pointerup', release);
  keyboard.addEventListener('pointercancel', release);

  const setOctave = (value) => {
    allOff();
    octave = Math.max(-3, Math.min(3, value));
    octaveLabel.textContent = `C${3 + octave}`;
  };
  setOctave(0);
  down.onclick = () => setOctave(octave - 1);
  up.onclick = () => setOctave(octave + 1);

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.target instanceof HTMLInputElement && event.target.classList.contains('menu-filter')) return;
    const k = event.key.toLowerCase();
    if (k === 'z') return setOctave(octave - 1);
    if (k === 'x') return setOctave(octave + 1);
    const i = KEYS.indexOf(k);
    if (i >= 0) {
      event.preventDefault();
      noteOn(LOW + 12 + octave * 12 + i);
    }
  });
  window.addEventListener('keyup', (event) => {
    const i = KEYS.indexOf(event.key.toLowerCase());
    if (i >= 0) noteOff(LOW + 12 + octave * 12 + i);
  });
  window.addEventListener('blur', allOff);

  const buildParams = (instrument) => {
    panel.textContent = '';
    instrument.sliders = new Map();
    const groups = new Map();
    for (const spec of instrument.ready.params) {
      const group = spec.group || '';
      if (!groups.has(group)) {
        const section = el('section', 'group', panel);
        if (group) el('h2', '', section).textContent = group;
        groups.set(group, el('div', 'group-body', section));
      }
      const body = groups.get(group);
      const row = el('div', 'param', body);
      const head = el('div', 'param-head', row);
      el('span', 'param-label', head).textContent = spec.label;
      const value = el('span', 'param-value', head);
      const send = (v) => {
        instrument.values[spec.key] = v;
        value.textContent = formatValue(spec, v);
        instrument.node.port.postMessage({ type: 'param', key: spec.key, value: v });
      };
      if (spec.options && spec.options.length > 4) {
        const choice = menu(row, (i) => send(i));
        choice.setItems(spec.options);
        value.style.display = 'none';
        instrument.sliders.set(spec.key, {
          set(v) {
            choice.set(Math.round(v));
          },
        });
      } else if (spec.options) {
        const segments = el('div', 'segments', row);
        value.style.display = 'none';
        const buttons = spec.options.map((option, i) => {
          const b = el('button', 'segment', segments);
          b.type = 'button';
          b.textContent = option;
          b.onclick = () => {
            buttons.forEach((x, j) => x.classList.toggle('on', j === i));
            send(i);
          };
          return b;
        });
        instrument.sliders.set(spec.key, {
          set(v) {
            buttons.forEach((x, j) => x.classList.toggle('on', j === Math.round(v)));
          },
        });
      } else {
        const input = el('input', 'slider', row);
        input.type = 'range';
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step || (spec.max - spec.min) / 1000);
        const paint = () => {
          const f = (Number(input.value) - spec.min) / (spec.max - spec.min || 1);
          input.style.setProperty('--fill', `${f * 100}%`);
        };
        input.addEventListener('input', () => {
          paint();
          send(Number(input.value));
        });
        input.addEventListener('dblclick', () => {
          input.value = String(spec.default);
          paint();
          send(spec.default);
        });
        instrument.sliders.set(spec.key, {
          set(v) {
            input.value = String(v);
            value.textContent = formatValue(spec, v);
            paint();
          },
        });
      }
      instrument.sliders.get(spec.key).set(instrument.values[spec.key] ?? spec.default);
      value.textContent = formatValue(spec, instrument.values[spec.key] ?? spec.default);
    }
  };

  const showPresets = (instrument) => {
    const presets = instrument.ready.presets;
    presetMenu.setItems(presets.map((p) => p.name));
    presetMenu.set(instrument.preset);
    presetRow.style.visibility = presets.length ? '' : 'hidden';
  };

  const choosePreset = (i) => {
    if (!active) return;
    const presets = active.ready.presets;
    if (!presets.length) return;
    i = (i + presets.length) % presets.length;
    active.preset = i;
    presetMenu.set(i);
    sendPreset(context, active, presets[i].id).catch((error) => {
      status.textContent = String(error.message || error);
    });
  };
  prev.onclick = () => choosePreset((active?.preset ?? 0) - 1);
  next.onclick = () => choosePreset((active?.preset ?? 0) + 1);

  const open = async (def) => {
    allOff();
    status.textContent = '';
    if (!loaded.has(def.name)) {
      const { node, ready } = await loadNode(context, def.name, def.effect);
      const instrument = { ...def, node, ready, values: {}, preset: -1, sliders: new Map() };
      for (const spec of ready.params) instrument.values[spec.key] = spec.default;
      node.port.onmessage = (event) => {
        if (event.data.type !== 'presetLoaded') return;
        Object.assign(instrument.values, event.data.values);
        for (const [key, v] of Object.entries(event.data.values)) instrument.sliders.get(key)?.set(v);
      };
      loaded.set(def.name, instrument);
      if (ready.presets.length) {
        instrument.preset = 0;
        await sendPreset(context, instrument, ready.presets[0].id);
      }
    }
    const instrument = loaded.get(def.name);
    if (def.effect) {
      if (!source) {
        const { node, ready } = await loadNode(context, def.source, false);
        source = { name: def.source, node, ready };
        if (ready.presets.length) node.port.postMessage({ type: 'preset', id: ready.presets[0].id });
      }
    }
    for (const other of loaded.values()) other.node.disconnect();
    if (source) source.node.disconnect();
    if (def.effect) {
      source.node.connect(instrument.node);
      instrument.node.connect(context.destination);
    } else {
      instrument.node.connect(context.destination);
    }
    active = instrument;
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.name === def.name));
    showPresets(instrument);
    buildParams(instrument);
  };

  if (instruments.length > 1) {
    for (const def of instruments) {
      const tab = el('button', 'tab', tabs);
      tab.type = 'button';
      tab.dataset.name = def.name;
      tab.textContent = def.label;
      tab.onclick = () => open(def).catch(showError);
    }
  }
  const showError = (error) => {
    status.textContent = String(error.message || error);
  };
  open(instruments[0]).catch(showError);
}
