import fs from 'node:fs/promises';
import path from 'node:path';
import { renderNotes } from '../engine/synth.mjs';
import { decodeDrumWav, renderDrums, encodeStereoWav } from '../engine/drums.mjs';

export function validateSamRequest(body) {
  const fail = (message) => { throw Object.assign(new Error(message), {status:400}); };
  if (!body || !Array.isArray(body.targets) || !body.targets.length || body.targets.length > 24)
    fail('Describe between 1 and 24 instruments for this run.');
  const targets = body.targets.map((t) => {
    if (!t || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 80 ||
        typeof t.description !== 'string' || t.description.trim().length < 3 || t.description.length > 500 ||
        !['melodic', 'drum'].includes(t.engine)) fail('Give each instrument a name, sound description and type.');
    return {name:t.name.trim(), description:t.description.trim(), engine:t.engine};
  });
  if (new Set(targets.map(t=>t.description.toLowerCase())).size !== targets.length)
    fail('Use a distinct description for each instrument.');
  if (!['none','predict'].includes(body.spanMode)) fail('Choose text-only or automatic timing prompts.');
  if (![1,4].includes(body.candidates)) fail('Choose one or four candidates.');
  let range = null;
  if (body.range != null) {
    if (!Array.isArray(body.range) || body.range.length !== 2 ||
        !body.range.every(Number.isFinite) || body.range[0] < 0 || body.range[1] <= body.range[0])
      fail('Choose a valid passage start and end in seconds.');
    range = body.range;
  }
  return {targets, spanMode:body.spanMode, candidates:body.candidates, range};
}

export async function renderSamProject(folder, result, generation) {
  const sr = 44100, length = Math.ceil(result.duration * sr);
  const mix = [new Float32Array(length), new Float32Array(length)];
  for (const part of result.parts) {
    let channels;
    if (part.engine === 'drum') {
      const bytes = await fs.readFile(path.join(folder, part.sampleFile));
      const asset = decodeDrumWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength));
      channels = renderDrums([{...part, asset}], result.duration, sr);
    } else {
      const mono = renderNotes(part.patch, part.notes, result.duration, sr);
      channels = [mono, mono];
    }
    part.synthFile = `${generation}-${part.id}-synth.wav`;
    await fs.writeFile(path.join(folder, part.synthFile), new Uint8Array(encodeStereoWav(channels,sr)));
    for (let c=0;c<2;c++) for (let i=0;i<length;i++) mix[c][i] += channels[c]?.[i] || 0;
  }
  result.reconstructionFile = generation+'-reconstruction.wav';
  await fs.writeFile(path.join(folder,result.reconstructionFile),new Uint8Array(encodeStereoWav(mix,sr)));
  return result;
}

export async function referencePeaks(folder, part) {
  const bytes = await fs.readFile(path.join(folder,part.referenceFile));
  const asset = decodeDrumWav(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const length = asset.channels[0].length, count = Math.min(12000,length);
  part.referenceWaveform = Array.from({length:count},(_,i)=>{
    let peak=0;
    for(let n=Math.floor(i*length/count);n<Math.floor((i+1)*length/count);n++)
      for(const channel of asset.channels) peak=Math.max(peak,Math.abs(channel[n]));
    return peak;
  });
}
