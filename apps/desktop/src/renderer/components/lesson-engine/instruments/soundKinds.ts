// The kinds of sound every instrument and synth preset is found by in the
// instruments panel: one list for all of them, the Melodics Synth's, the
// ports' (Surge XT, OB-Xf, Dexed, Helm, Vital, Mutable Instruments) and the
// sampled instruments'. A preset's own tag says its kind where one maps to
// it (each synth names its tags its own way); otherwise its name does.

export const SOUND_KINDS = [
  'Lead',
  'Bass',
  'Pad',
  'Keys',
  'Pluck',
  'Chords',
  'Bell & Mallet',
  'Strings',
  'Brass & Wind',
  'Guitar',
  'Voice',
  'Drums',
  'FX',
  'Sequence',
] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

// Each synth's tags, lower case, by the kind they are
const TAG_KINDS: Record<string, SoundKind> = {
  lead: 'Lead',
  leads: 'Lead',
  chip: 'Lead',
  bass: 'Bass',
  basses: 'Bass',
  pad: 'Pad',
  pads: 'Pad',
  atmospheres: 'Pad',
  soundscapes: 'Pad',
  keys: 'Keys',
  organs: 'Keys',
  'mallets & keys': 'Keys',
  pluck: 'Pluck',
  plucks: 'Pluck',
  'pluck & stab': 'Pluck',
  chords: 'Chords',
  polysynths: 'Chords',
  bell: 'Bell & Mallet',
  bells: 'Bell & Mallet',
  mallet: 'Bell & Mallet',
  mallets: 'Bell & Mallet',
  strings: 'Strings',
  brass: 'Brass & Wind',
  wind: 'Brass & Wind',
  winds: 'Brass & Wind',
  guitars: 'Guitar',
  voice: 'Voice',
  voices: 'Voice',
  drum: 'Drums',
  drums: 'Drums',
  percussion: 'Drums',
  fx: 'FX',
  sfx: 'FX',
  experiment: 'FX',
  harsh: 'FX',
  arp: 'Sequence',
  sequence: 'Sequence',
  sequences: 'Sequence',
};

// Words in a name, by the kind they say, the first that matches winning
// ("Bassoon" is a wind, "Steel drums" a mallet, "Piano Stab FX" keys)
const NAME_KINDS: [RegExp, SoundKind][] = [
  [/bassoon|brass|horn|trumpet|trombone|tuba|sax|flute|flite|clarinet|oboe|harmonica|recorder|whistle|pan ?pipe/, 'Brass & Wind'],
  [/bell|marimba|rimba|xylo|vibe|glock|celest|kalimba|music ?box|steel ?drum|gamelan|chime/, 'Bell & Mallet'],
  [/harpsi|piano|pno|rhod|wurli|clav|organ|hammond|harmonium|accordion|\be\.? ?p\b|\bkeys?\b/, 'Keys'],
  [/bass|\bsub\b|808/, 'Bass'],
  [/drum|kick|snare|hi ?hat|\bhats?\b|perc|\btoms?\b|clap|cymbal|conga|bongo|timbale|wood ?block|shaker|rim ?shot/, 'Drums'],
  [/string|strng|\bstg\b|violin|viola|cello|chello|pizz|orchestra|\bharp/, 'Strings'],
  [/guitar|gtr|sitar|koto|banjo|mandolin|nylon/, 'Guitar'],
  [/voice|vox|vocal|choir|\baah|\booh|talk/, 'Voice'],
  [/\bpad|atmos|ambien|drone|halo|soundscape/, 'Pad'],
  [/lead|solo|melody|chip|8 ?bit/, 'Lead'],
  [/pluck|pluk|stab/, 'Pluck'],
  [/chord|poly/, 'Chords'],
  [/\barp|seq/, 'Sequence'],
  [/\bfx\b|sfx|noise|laser|zap|riser|siren|alarm|\bwar\b/, 'FX'],
];

// A preset's or an instrument's kind: by its tag, else by its name; none when neither says
export function soundKind(name: string, tag?: string): SoundKind | null {
  const tagged = tag ? TAG_KINDS[tag.toLowerCase()] : undefined;
  if (tagged) return tagged;
  const words = name.toLowerCase();
  return NAME_KINDS.find(([pattern]) => pattern.test(words))?.[1] ?? null;
}
