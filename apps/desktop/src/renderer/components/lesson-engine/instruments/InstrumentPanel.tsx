import { useMemo, useRef, useState, type ReactNode } from 'react';
import { BackIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, SYNTH_TAG_ICONS, SearchIcon } from '../JamIcons';
import { JamDropdown } from '../JamDropdown';
import { CategoryArt } from './CategoryArt';
import { CATEGORY_ORDER, SYNTH_TAG_ORDER, choiceEdited, presetChoice } from './catalog';
import { EFFECTS, effectSlot } from './effects';
import type { EffectKind, EffectSlot, InstrumentChoice, InstrumentDef, ParamSpec, ParamValues, Preset } from './types';
import { EFFECT_KINDS } from './types';
import { paramValue } from './types';
import './InstrumentPanel.css';

// The instruments panel, down the left side: synth sounds by kind and sampled
// instruments by category as cards; then an instrument's presets, parameters
// and effects

interface InstrumentPanelProps {
  instruments: InstrumentDef[];
  choice: InstrumentChoice;
  // The chosen instrument is still loading
  loading: boolean;
  // How each instrument was last left, to go back to it
  saved: Record<string, InstrumentChoice>;
  onChange: (choice: InstrumentChoice) => void;
  onClose: () => void;
}

type View =
  | { at: 'home' }
  | { at: 'tag'; tag: string }
  | { at: 'category'; category: string }
  | { at: 'instrument'; id: string };

const SECONDS = new Set(['attack', 'decay', 'hold', 'release', 'sweepTime', 'size']);

function formatParam(spec: ParamSpec, value: number): string {
  if (spec.options) return spec.options[Math.round(value)] ?? '';
  if (SECONDS.has(spec.key)) return value < 0.1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
  if (['octave', 'tune'].includes(spec.key)) return `${value > 0 ? '+' : ''}${Number(value.toFixed(1))}`;
  if (['fine', 'detune', 'vibrato'].includes(spec.key)) return `${Math.round(value)} ct`;
  if (spec.key === 'ratio') return `×${value}`;
  if (spec.key === 'odd') return `${Math.round((0.12 + 0.32 * value) * 100)}%`;
  if ((spec.key === 'cutoff' || spec.key === 'cutoffEnd') && spec.max <= 32) return value >= spec.max ? 'Open' : `×${value.toFixed(1)}`;
  if (['cutoff', 'frequency'].includes(spec.key)) return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`;
  if (spec.key === 'rate') return `${value.toFixed(2)} Hz`;
  if (['low', 'mid', 'high', 'threshold'].includes(spec.key)) return `${value > 0 ? '+' : ''}${value} dB`;
  if (spec.key === 'ratio' || spec.key === 'bits' || spec.key === 'octaves') return `${value}`;
  if (spec.max <= 2) return `${Math.round(value * 100)}%`;
  return Number(value.toFixed(2)).toString();
}

function Param({ spec, value, onChange }: { spec: ParamSpec; value: number; onChange: (value: number) => void }) {
  if (spec.options)
    return (
      <div className="jam-slider">
        <div className="jam-slider-head">
          <span>{spec.label}</span>
        </div>
        <div className="instrument-options">
          {spec.options.map((option, i) => (
            <button key={option} className={`jam-sound-option ${Math.round(value) === i ? 'active' : ''}`} onClick={() => onChange(i)}>
              {option}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <div className="jam-slider">
      <div className="jam-slider-head">
        <span>{spec.label}</span>
        <span className="jam-slider-value">{formatParam(spec, value)}</span>
      </div>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="volume-slider"
      />
    </div>
  );
}

function Params({ specs, values, onChange }: { specs: ParamSpec[]; values: ParamValues; onChange: (values: ParamValues) => void }) {
  const groups = [...new Set(specs.map((spec) => spec.group ?? ''))];
  return (
    <>
      {groups.map((group) => (
        <div key={group} className="instrument-param-group">
          {group && <div className="jam-subhead">{group}</div>}
          {specs
            .filter((spec) => (spec.group ?? '') === group)
            .map((spec) => (
              <Param key={spec.key} spec={spec} value={paramValue(specs, values, spec.key)} onChange={(value) => onChange({ ...values, [spec.key]: value })} />
            ))}
        </div>
      ))}
    </>
  );
}

// A row of cards that scrolls sideways, with arrows to page through it
function CardRow({ title, children }: { title: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const page = (direction: number) => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <section className="instrument-section">
      <div className="instrument-section-head">
        <h3>{title}</h3>
        <div className="instrument-section-arrows">
          <button className="instrument-icon-btn" onClick={() => page(-1)} title="Previous">
            <ChevronLeftIcon />
          </button>
          <button className="instrument-icon-btn" onClick={() => page(1)} title="Next">
            <ChevronRightIcon />
          </button>
        </div>
      </div>
      <div className="instrument-row" ref={row}>
        {children}
      </div>
    </section>
  );
}

function Card({ art, name, detail, active, onClick }: { art: ReactNode; name: string; detail: string; active?: boolean; onClick: () => void }) {
  return (
    <button className={`instrument-card ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="instrument-card-art">{art}</span>
      <span className="instrument-card-name">{name}</span>
      <span className="instrument-card-detail">{detail}</span>
    </button>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function InstrumentPanel({ instruments, choice, loading, saved, onChange, onClose }: InstrumentPanelProps) {
  const [view, setView] = useState<View>({ at: 'home' });
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const synths = instruments.filter((instrument) => instrument.engine === 'melodics-synth');
  const sampled = instruments.filter((instrument) => instrument.engine !== 'melodics-synth');
  const rank = (category: string) => (CATEGORY_ORDER.includes(category) ? CATEGORY_ORDER.indexOf(category) : CATEGORY_ORDER.length);
  const categories = [...new Set(sampled.map((instrument) => instrument.category))].sort((a, b) => rank(a) - rank(b));
  const tagged = (tag: string) =>
    synths.flatMap((instrument) => instrument.presets.filter((preset) => preset.tag === tag).map((preset) => ({ instrument, preset })));
  const tags = SYNTH_TAG_ORDER.filter((tag) => tagged(tag).length);
  const artSeed = (instrument: InstrumentDef) => instruments.indexOf(instrument);

  const pick = (instrument: InstrumentDef, preset?: Preset) => {
    onChange(preset ? presetChoice(instrument, preset.id) : (saved[instrument.id] ?? presetChoice(instrument)));
    setView({ at: 'instrument', id: instrument.id });
  };

  const results = useMemo<{ instrument: InstrumentDef; preset?: Preset }[]>(() => {
    const words = query.trim().toLowerCase();
    if (!words) return [];
    return instruments.flatMap((instrument) => {
      if (instrument.engine === 'melodics-synth')
        return instrument.presets
          .filter((preset) => `${preset.name} ${preset.tag}`.toLowerCase().includes(words))
          .map((preset) => ({ instrument, preset }));
      return `${instrument.name} ${instrument.category}`.toLowerCase().includes(words) ? [{ instrument }] : [];
    });
  }, [instruments, query]);

  const synthCard = (instrument: InstrumentDef, preset: Preset) => {
    const Icon = SYNTH_TAG_ICONS[preset.tag ?? 'Lead'];
    return (
      <Card
        key={`${instrument.id}:${preset.id}`}
        art={<span className="instrument-card-icon">{Icon && <Icon />}</span>}
        name={preset.name}
        detail={instrument.name}
        active={choice.instrument === instrument.id && choice.preset === preset.id}
        onClick={() => pick(instrument, preset)}
      />
    );
  };
  const sampledCard = (instrument: InstrumentDef) => (
    <Card
      key={instrument.id}
      art={<CategoryArt seed={artSeed(instrument)} />}
      name={instrument.name}
      detail={instrument.pads ? plural(instrument.pads.length, 'sound') : instrument.category}
      active={choice.instrument === instrument.id}
      onClick={() => pick(instrument)}
    />
  );

  const current = view.at === 'instrument' ? instruments.find((instrument) => instrument.id === view.id) : undefined;
  const title =
    view.at === 'tag' ? view.tag : view.at === 'category' ? view.category : current ? current.name : 'Instruments';
  const back =
    view.at === 'home'
      ? undefined
      : () => {
          if (view.at === 'instrument' && current?.engine === 'melodics-synth') {
            const preset = current.presets.find((candidate) => candidate.id === choice.preset);
            setView(preset?.tag ? { at: 'tag', tag: preset.tag } : { at: 'home' });
          } else if (view.at === 'instrument' && current) setView({ at: 'category', category: current.category });
          else setView({ at: 'home' });
        };

  const setEffects = (effects: EffectSlot[]) => onChange({ ...choice, effects });

  return (
    <aside className="instrument-panel">
      <header className="instrument-panel-head">
        {back && (
          <button className="instrument-icon-btn" onClick={back} title="Back">
            <BackIcon />
          </button>
        )}
        {searching ? (
          <input
            className="instrument-search"
            autoFocus
            value={query}
            placeholder="Search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setSearching(false), setQuery(''))}
          />
        ) : (
          <h2>{title}</h2>
        )}
        <button
          className={`instrument-icon-btn ${searching ? 'on' : ''}`}
          onClick={() => {
            setSearching(!searching);
            setQuery('');
          }}
          title="Search"
        >
          <SearchIcon />
        </button>
        <button className="instrument-icon-btn" onClick={onClose} title="Hide instruments">
          <CloseIcon />
        </button>
      </header>

      <div className="instrument-panel-body">
        {searching && query.trim() ? (
          <div className="instrument-grid">
            {results.map(({ instrument, preset }) => (preset ? synthCard(instrument, preset) : sampledCard(instrument)))}
          </div>
        ) : view.at === 'home' ? (
          <>
            <CardRow title="Synths">
              {tags.map((tag) => {
                const Icon = SYNTH_TAG_ICONS[tag];
                return (
                  <Card
                    key={tag}
                    art={<span className="instrument-card-icon">{Icon && <Icon />}</span>}
                    name={tag}
                    detail={plural(tagged(tag).length, 'sound')}
                    onClick={() => setView({ at: 'tag', tag })}
                  />
                );
              })}
            </CardRow>
            <CardRow title="Samplers">
              {categories.map((category) => (
                <Card
                  key={category}
                  art={<CategoryArt seed={categories.indexOf(category) * 2 + 1} />}
                  name={category}
                  detail={plural(sampled.filter((instrument) => instrument.category === category).length, 'instrument')}
                  onClick={() => setView({ at: 'category', category })}
                />
              ))}
            </CardRow>
          </>
        ) : view.at === 'tag' ? (
          <div className="instrument-grid">{tagged(view.tag).map(({ instrument, preset }) => synthCard(instrument, preset))}</div>
        ) : view.at === 'category' ? (
          <div className="instrument-grid">
            {sampled.filter((instrument) => instrument.category === view.category).map(sampledCard)}
          </div>
        ) : current && choice.instrument === current.id ? (
          <div className="instrument-detail">
            <div className="instrument-detail-head">
              <span className="instrument-detail-art">
                {current.engine === 'melodics-synth' ? (
                  <span className="instrument-card-icon">{(() => {
                    const Icon = SYNTH_TAG_ICONS[current.presets.find((preset) => preset.id === choice.preset)?.tag ?? 'Lead'];
                    return Icon && <Icon />;
                  })()}</span>
                ) : (
                  <CategoryArt seed={artSeed(current)} />
                )}
              </span>
              <span className="instrument-detail-title">
                <span className="instrument-card-name">{current.name}</span>
                <span className="instrument-card-detail">{loading ? 'Loading…' : current.category}</span>
              </span>
              {choiceEdited(current, choice) && (
                <button className="jam-reset" onClick={() => onChange(presetChoice(current, choice.preset))}>
                  Reset
                </button>
              )}
            </div>

            <div className="jam-subhead">Presets</div>
            <div className="instrument-options">
              {current.presets.map((preset) => (
                <button
                  key={preset.id}
                  className={`jam-sound-option ${preset.id === choice.preset ? 'active' : ''}`}
                  onClick={() => onChange(presetChoice(current, preset.id))}
                >
                  {preset.name}
                </button>
              ))}
            </div>

            <Params specs={current.params} values={choice.params} onChange={(params) => onChange({ ...choice, params })} />

            <div className="instrument-effects-head">
              <div className="jam-subhead">Effects</div>
              <JamDropdown
                className="instrument-add-effect"
                placeholder="Add effect"
                value=""
                groups={[{ options: EFFECT_KINDS.map((kind) => ({ value: kind, label: EFFECTS[kind].label })) }]}
                onChange={(kind) => setEffects([...choice.effects, effectSlot(kind as EffectKind)])}
              />
            </div>
            {choice.effects.map((slot, i) => (
              <div key={i} className={`instrument-effect ${slot.on ? '' : 'off'}`}>
                <div className="instrument-effect-head">
                  <span>{EFFECTS[slot.kind].label}</span>
                  <button
                    className={`jam-sound-option ${slot.on ? 'active' : ''}`}
                    onClick={() => setEffects(choice.effects.map((other, j) => (j === i ? { ...other, on: !other.on } : other)))}
                  >
                    {slot.on ? 'On' : 'Off'}
                  </button>
                  <button
                    className="instrument-icon-btn"
                    onClick={() => setEffects(choice.effects.filter((_, j) => j !== i))}
                    title="Remove effect"
                  >
                    <CloseIcon />
                  </button>
                </div>
                {slot.on && (
                  <Params
                    specs={EFFECTS[slot.kind].params}
                    values={slot.params}
                    onChange={(params) => setEffects(choice.effects.map((other, j) => (j === i ? { ...other, params } : other)))}
                  />
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
