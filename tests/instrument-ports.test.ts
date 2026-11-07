// The instrument ports in the app: their catalog entries become instruments
// and effects, each preset is brought to the Jam's level, and a port is sent
// only what changes
jest.mock('tone', () => ({}));

import { portInstruments, presetChoice } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/catalog';
import { EFFECTS, availableEffects, registerPortEffects } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/effects';
import { PortControl, PortSender, portGain, type PortEntry } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/engines/port';
import { JAM_SOUND_LOUDNESS } from '../apps/desktop/src/renderer/components/lesson-engine/jamLoudness';

const param = (key: string, value: number) => ({ key, label: key, min: 0, max: 10, step: 1, default: value });

const synth: PortEntry = {
  name: 'helm',
  label: 'Helm',
  effect: false,
  files: { worklet: 'helm.worklet.js', wasm: 'helm.wasm' },
  params: [param('cutoff', 5), param('drive', 0)],
  presets: [
    { id: '0', raw: 0, name: 'Pluck', tag: 'Keys', params: { cutoff: 8 }, loudness: JAM_SOUND_LOUDNESS - 6 },
    { id: '1', raw: 1, name: 'Swell', params: { drive: 3 }, loudness: -110 },
  ],
  loudness: JAM_SOUND_LOUDNESS + 4,
};

const clouds: PortEntry = {
  name: 'clouds',
  label: 'Clouds',
  effect: true,
  files: { worklet: 'clouds.worklet.js', wasm: 'clouds.wasm' },
  params: [param('mix', 5)],
  presets: [{ id: '0', raw: 0, name: 'Grains', params: {} }],
};

const dB = (gain: number) => Math.round(20 * Math.log10(gain) * 10) / 10;

describe('instrument ports', () => {
  it('lists each port that is not an effect as an instrument with its presets', () => {
    const [helm, ...rest] = portInstruments([synth, clouds]);
    expect(rest).toHaveLength(0);
    expect(helm).toMatchObject({ id: 'port:helm', name: 'Helm', category: 'Synth engines', engine: 'port', source: synth });
    expect(helm.presets.map((preset) => [preset.id, preset.name, preset.tag])).toEqual([
      ['0', 'Pluck', 'Keys'],
      ['1', 'Swell', undefined],
    ]);
    expect(presetChoice(helm, '0')).toMatchObject({ instrument: 'port:helm', preset: '0', params: { cutoff: 8 } });
  });

  it('brings each preset to the Jam level, a quiet one raised by 12 dB at most', () => {
    expect(dB(portGain(synth, '0'))).toBe(6);
    expect(dB(portGain(synth, '1'))).toBe(12);
    // the port as it starts
    expect(dB(portGain(synth, null))).toBe(-4);
  });

  it('sends a preset once, then only the parameters that differ from it', () => {
    const sent: object[] = [];
    const control = new PortControl(synth, (message) => sent.push(message));
    control.set('0', { cutoff: 8, drive: 2 });
    expect(sent).toEqual([
      { type: 'preset', id: 0 },
      { type: 'param', key: 'drive', value: 2 },
    ]);
    sent.length = 0;
    control.set('0', { cutoff: 8, drive: 2 });
    expect(sent).toEqual([]);
    control.set('0', { cutoff: 1, drive: 2 });
    expect(sent).toEqual([{ type: 'param', key: 'cutoff', value: 1 }]);
    sent.length = 0;
    // a new preset's own values are not sent again
    control.set('1', { cutoff: 5, drive: 3 });
    expect(sent).toEqual([{ type: 'preset', id: 1 }]);
  });

  it('sends a fetched preset with its file, holding back what follows it, and drops one replaced while fetching', async () => {
    const vital: PortEntry = {
      ...synth,
      name: 'vital',
      files: { worklet: 'vital.worklet.js', wasm: 'vital.wasm', presets: 'presets/{id}.vital', loader: 'vital.loader.js' },
    };
    const posted: { type: string; id?: unknown; key?: string; data?: ArrayBuffer }[] = [];
    const node = { port: { postMessage: (message: (typeof posted)[number]) => posted.push(message) } };
    const fetched: Record<string, () => void> = {};
    const fetchPreset = (_: PortEntry, raw: string | number) =>
      new Promise<ArrayBuffer>((resolve) => {
        fetched[String(raw)] = () => resolve(new Uint8Array([10 + Number(raw)]).buffer);
      });
    const sender = new PortSender(vital, () => node as unknown as AudioWorkletNode, fetchPreset);

    sender.send({ type: 'preset', id: 0 });
    sender.send({ type: 'param', key: 'drive', value: 2 } as { type: string });
    sender.send({ type: 'preset', id: 1 });
    sender.send({ type: 'param', key: 'cutoff', value: 3 } as { type: string });
    await Promise.resolve();
    expect(posted).toEqual([]);

    fetched['1']();
    fetched['0']();
    await sender.settled();
    expect(posted.map(({ type, id, key }) => [type, id ?? key])).toEqual([
      ['param', 'drive'],
      ['preset', 1],
      ['param', 'cutoff'],
    ]);
    // the pack of preset 1
    expect([...new Uint8Array(posted[1].data!)]).toEqual([11]);
  });

  it('sends the presets of a port that has them inside it straight away', async () => {
    const posted: object[] = [];
    const sender = new PortSender(synth, () => ({ port: { postMessage: (message: object) => posted.push(message) } }) as unknown as AudioWorkletNode);
    sender.send({ type: 'preset', id: 0 });
    await sender.settled();
    expect(posted).toEqual([{ type: 'preset', id: 0 }]);
  });

  it('offers Clouds as an effect once the catalog has it', () => {
    expect(availableEffects()).not.toContain('clouds');
    registerPortEffects([synth, clouds]);
    expect(availableEffects()).toContain('clouds');
    expect(EFFECTS.clouds).toEqual({ label: 'Clouds', params: clouds.params });
  });
});
