// Makes the templates the Daw's Ableton export builds its Live Sets from, out
// of Ableton Live's own defaults (the Live Sets it starts a new MIDI or audio
// track from, and its Sampler), so an exported set is one Live writes itself.
//
//   node scripts/make-ableton-export-templates.mjs ["/Applications/Ableton Live 12 Suite.app"]
//
// Writes lesson-engine/ableton/{live-set,midi-track,audio-track,sampler}.xml,
// with {{...}} where the export puts its own values.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const app = process.argv[2] ?? "/Applications/Ableton Live 12 Suite.app";
const defaults = path.join(app, "Contents/App-Resources/Core Library/Defaults");
const out = path.resolve(import.meta.dirname, "../apps/desktop/src/renderer/components/lesson-engine/ableton");
fs.mkdirSync(out, { recursive: true });

const read = (file) => zlib.gunzipSync(fs.readFileSync(path.join(defaults, file))).toString("utf8");

// One element (its first, from its opening tag to its closing one)
function element(xml, tag) {
  const start = xml.search(new RegExp(`<${tag}[ >]`));
  const end = xml.indexOf(`</${tag}>`, start) + `</${tag}>`.length;
  if (start < 0 || end < start) throw new Error(`No <${tag}> in the template`);
  return { start, end, text: xml.slice(start, end) };
}

// Replaces exactly one match, so a changed default is noticed
function once(xml, pattern, replacement) {
  const matches = xml.match(new RegExp(pattern.source, "g")) ?? [];
  if (matches.length !== 1) throw new Error(`${pattern} matches ${matches.length} times`);
  return xml.replace(pattern, replacement);
}

// A track's arrangement clips go in its main sequencer's (the first) events,
// its name, color and on switch where Live keeps them
function track(xml, tag) {
  let text = element(xml, tag).text;
  text = once(text, new RegExp(`^<${tag} Id="0"`), `<${tag} Id="{{ID}}"`);
  text = once(text, /(<EffectiveName Value="1-(?:MIDI|Audio)" \/>\s*)<UserName Value="" \/>/, '$1<UserName Value="{{NAME}}" />');
  text = once(text, /(<MemorizedFirstClipName Value="" \/>\s*<\/Name>\s*)<Color Value="\d+" \/>/, '$1<Color Value="{{COLOR}}" />');
  // A track whose parts are all muted in the Daw is switched off
  text = once(text, /(<Speaker>\s*<LomId Value="0" \/>\s*)<Manual Value="true" \/>/, '$1<Manual Value="{{ON}}" />');
  const sequencer = text.indexOf("<MainSequencer>");
  const events = text.indexOf("<Events />", sequencer);
  text = `${text.slice(0, events)}<Events>{{CLIPS}}</Events>${text.slice(events + "<Events />".length)}`;
  return text;
}

const midiSet = read("Creating Tracks/MIDI Track/Default MIDI Track.als");
const audioSet = read("Creating Tracks/Audio Track/Default Audio Track.als");

// The set: its one track taken out, its tempo the song's
const midiTrack = element(midiSet, "MidiTrack");
let liveSet = `${midiSet.slice(0, midiTrack.start)}{{TRACKS}}${midiSet.slice(midiTrack.end)}`;
const tempo = element(liveSet, "Tempo");
const tempoTarget = /<AutomationTarget Id="(\d+)">/.exec(tempo.text)[1];
liveSet = liveSet.slice(0, tempo.start) + once(tempo.text, /<Manual Value="120" \/>/, '<Manual Value="{{BPM}}" />') + liveSet.slice(tempo.end);
liveSet = once(
  liveSet,
  new RegExp(`(<PointeeId Value="${tempoTarget}" />\\s*</EnvelopeTarget>\\s*<Automation>\\s*<Events>\\s*<FloatEvent Id="0" Time="-63072000") Value="120"`),
  '$1 Value="{{BPM}}"'
);
liveSet = once(liveSet, /<NextPointeeId Value="\d+" \/>/, '<NextPointeeId Value="{{NEXT_ID}}" />');
// The arrangement's loop: the whole song
liveSet = once(liveSet, /(<Transport>[\s\S]*?)<LoopStart Value="\d+" \/>/, '$1<LoopStart Value="0" />');
liveSet = once(liveSet, /(<Transport>[\s\S]*?)<LoopLength Value="\d+" \/>/, '$1<LoopLength Value="{{BEATS}}" />');

let midi = track(midiSet, "MidiTrack");
midi = once(midi, /(<\/MainSequencer>[\s\S]*?)<Devices \/>/, "$1<Devices>{{DEVICES}}</Devices>");
const audio = track(audioSet, "AudioTrack");

// The Sampler: at unity gain, playing louder with velocity, its notes ringing
// on when let go (each zone's sound ends as it does in the Daw)
let sampler = element(read("Instruments/Sampler.adv"), "MultiSampler").text;
sampler = once(sampler, /(<VolumeAndPan>\s*<Volume>\s*<LomId Value="0" \/>\s*)<Manual Value="-12" \/>/, '$1<Manual Value="0" />');
sampler = once(sampler, /(<VolumeVelScale>\s*<LomId Value="0" \/>\s*)<Manual Value="0" \/>/, '$1<Manual Value="1" />');
sampler = once(
  sampler,
  /(<VolumeAndPan>[\s\S]*?<ReleaseTime>\s*<LomId Value="0" \/>\s*)<Manual Value="50" \/>/,
  '$1<Manual Value="{{RELEASE_MS}}" />'
);
// A device in a track's list has an id there
sampler = once(sampler, /^<MultiSampler>/, '<MultiSampler Id="0">');
sampler = once(sampler, /<SampleParts \/>/, "<SampleParts>{{ZONES}}</SampleParts>");
sampler = once(sampler, /<UserName Value="" \/>/, '<UserName Value="{{NAME}}" />');

const header = midiSet.slice(0, midiSet.indexOf("<LiveSet>"));
for (const [file, xml] of Object.entries({
  "live-set.xml": liveSet,
  "midi-track.xml": midi,
  "audio-track.xml": audio,
  "sampler.xml": sampler,
}))
  fs.writeFileSync(path.join(out, file), xml.endsWith("\n") ? xml : `${xml}\n`);
console.log(`Templates from ${header.match(/Creator="([^"]*)"/)[1]} written to ${path.relative(process.cwd(), out)}`);
