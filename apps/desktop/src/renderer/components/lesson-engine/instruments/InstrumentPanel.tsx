import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BackIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FilterIcon,
  SYNTH_TAG_ICONS,
  SearchIcon,
  StarIcon,
  TrackSoundIcon,
} from '../JamIcons';
import { JamDropdown } from '../JamDropdown';
import { CategoryArt } from './CategoryArt';
import { CATEGORY_ORDER, SYNTH_TAG_ORDER, choiceEdited, presetChoice } from './catalog';
import { EFFECTS, availableEffects, effectSlot } from './effects';
import type { EffectKind, EffectSlot, InstrumentChoice, InstrumentDef, ParamSpec, ParamValues, Preset } from './types';
import { paramValue } from './types';
import './InstrumentPanel.css';

// The instruments panel, down the left side: synth sounds by kind and sampled
// instruments by category as cards; then an instrument's presets, parameters
// and effects

interface InstrumentPanelProps {
  instruments: InstrumentDef[];
  // What plays now; none for a track playing its original sound
  choice: InstrumentChoice | null;
  // A Daw track's: its name, the instruments that fit it (kits for drums,
  // the others for notes), and for a track of the song's own its original
  // sound to go back to
  track?: { name: string; kind: 'notes' | 'drum'; original?: () => void; title?: string };
  // The chosen instrument is still loading
  loading: boolean;
  // How each instrument was last left, to go back to it
  saved: Record<string, InstrumentChoice>;
  onChange: (choice: InstrumentChoice) => void;
  // The tracks of the song playing as the backing track, each heard or muted
  backing?: { id: string; name: string; muted: boolean; onMute: (muted: boolean) => void }[];
  // A preset stepped to with the arrow keys: one low note of it, once it has loaded
  onPreview?: () => void;
  // The presets marked as favourites, by instrument
  favorites: JamFavorite[];
  onFavoritesChange: (favorites: JamFavorite[]) => void;
  onClose: () => void;
  // Shown inside another panel (the Jam's sidebar), under its header, rather than over the page
  embedded?: boolean;
}

export interface JamFavorite {
  instrument: string;
  preset: string;
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

// A choice of more options than fit as buttons opens as a list
const MAX_OPTION_BUTTONS = 8;

function Param({ spec, value, onChange }: { spec: ParamSpec; value: number; onChange: (value: number) => void }) {
  if (spec.options && spec.options.length > MAX_OPTION_BUTTONS)
    return (
      <div className="jam-slider">
        <div className="jam-slider-head">
          <span>{spec.label}</span>
        </div>
        <JamDropdown
          className="instrument-choice"
          value={String(Math.round(value))}
          groups={[{ options: spec.options.map((option, i) => ({ value: String(i), label: option })) }]}
          onChange={(index) => onChange(Number(index))}
        />
      </div>
    );
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

// A row of cards that scrolls sideways a page at a time, its arrows shown
// only when it holds more than one page
function CardRow({ title, children }: { title: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  useEffect(() => {
    const el = row.current!;
    const measure = () => setEdges({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const resized = new ResizeObserver(measure);
    resized.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      resized.disconnect();
    };
  }, []);
  // To the card a page away, so a page always starts on a whole card
  const page = (direction: number) => {
    const el = row.current!;
    const cards = el.children as HTMLCollectionOf<HTMLElement>;
    if (cards.length < 2) return;
    const step = cards[1].offsetLeft - cards[0].offsetLeft;
    const perPage = Math.round((el.clientWidth + parseFloat(getComputedStyle(el).columnGap)) / step);
    const card = Math.round(el.scrollLeft / step) + direction * perPage;
    el.scrollTo({ left: Math.max(0, Math.min(card * step, el.scrollWidth - el.clientWidth)), behavior: 'smooth' });
  };
  return (
    <section className="instrument-section">
      <div className="instrument-section-head">
        <h3>{title}</h3>
        {!(edges.start && edges.end) && (
          <div className="instrument-section-arrows">
            <button className="instrument-icon-btn" onClick={() => page(-1)} disabled={edges.start} title="Previous">
              <ChevronLeftIcon />
            </button>
            <button className="instrument-icon-btn" onClick={() => page(1)} disabled={edges.end} title="Next">
              <ChevronRightIcon />
            </button>
          </div>
        )}
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

// More presets than fit as buttons: a list to search, by kind of sound
const MAX_PRESET_BUTTONS = 12;

// The presets a list shows: those of the kind chosen (all when none) whose
// name matches the search, grouped by kind in their order
function shownPresets(presets: Preset[], filter: string, kind: string | null): Preset[] {
  const words = filter.trim().toLowerCase();
  const shown = presets.filter(
    (preset) => (kind === null || (preset.tag ?? '') === kind) && (!words || `${preset.name} ${preset.tag ?? ''}`.toLowerCase().includes(words))
  );
  const kinds = [...new Set(shown.map((preset) => preset.tag ?? ''))];
  return kinds.flatMap((tag) => shown.filter((preset) => (preset.tag ?? '') === tag));
}

function PresetList({
  presets,
  chosen,
  filter,
  onFilterChange,
  kind,
  onKindChange,
  isFavorite,
  onToggleFavorite,
  onPick,
}: {
  presets: Preset[];
  chosen: string;
  filter: string;
  onFilterChange: (filter: string) => void;
  kind: string | null;
  onKindChange: (kind: string | null) => void;
  isFavorite: (preset: Preset) => boolean;
  onToggleFavorite: (preset: Preset) => void;
  onPick: (preset: Preset) => void;
}) {
  const [kindsOpen, setKindsOpen] = useState(false);
  const shown = shownPresets(presets, filter, kind);
  const kinds = [...new Set(presets.map((preset) => preset.tag ?? ''))].filter(Boolean);
  const rowsRef = useRef<HTMLDivElement>(null);
  // The chosen preset stays in sight as the arrow keys step through the list
  useEffect(() => {
    rowsRef.current?.querySelector<HTMLElement>('.instrument-preset-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [chosen, kind, filter]);
  return (
    <div className="instrument-preset-list">
      <div className="instrument-preset-tools">
        <input
          className="instrument-search instrument-preset-search"
          value={filter}
          placeholder={`Search ${kind === null ? presets.length : presets.filter((preset) => preset.tag === kind).length} presets`}
          onChange={(e) => onFilterChange(e.target.value)}
        />
        {kinds.length > 1 && (
          <button
            className={`instrument-icon-btn instrument-preset-filter ${kind !== null ? 'on' : ''} ${kindsOpen ? 'open' : ''}`}
            onClick={() => setKindsOpen(!kindsOpen)}
            title="Kind of sound"
            aria-expanded={kindsOpen}
          >
            <FilterIcon />
          </button>
        )}
        {kindsOpen && (
          <div className="instrument-preset-kinds" role="menu">
            {[null, ...kinds].map((option) => (
              <button
                key={option ?? ''}
                role="menuitemradio"
                aria-checked={option === kind}
                className={option === kind ? 'active' : ''}
                onClick={() => {
                  onKindChange(option);
                  setKindsOpen(false);
                }}
              >
                <span>{option ?? 'All kinds'}</span>
                <span className="instrument-preset-kind-count">
                  {option === null ? presets.length : presets.filter((preset) => preset.tag === option).length}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {kind !== null && (
        <div className="instrument-preset-kind-chip">
          {kind}
          <button onClick={() => onKindChange(null)} aria-label={`Show every kind, not only ${kind}`}>
            <CloseIcon />
          </button>
        </div>
      )}
      <div className="instrument-preset-rows" ref={rowsRef}>
        {shown.map((preset, index) => (
          <div key={preset.id}>
            {(preset.tag ?? '') !== (shown[index - 1]?.tag ?? null) && preset.tag && kind === null && (
              <div className="instrument-preset-tag">{preset.tag}</div>
            )}
            <div className="instrument-preset-item">
              <button className={`instrument-preset-row ${preset.id === chosen ? 'active' : ''}`} onClick={() => onPick(preset)}>
                {preset.name}
              </button>
              <button
                className={`instrument-preset-star ${isFavorite(preset) ? 'on' : ''}`}
                onClick={() => onToggleFavorite(preset)}
                aria-label={isFavorite(preset) ? `Remove ${preset.name} from favourites` : `Add ${preset.name} to favourites`}
                title={isFavorite(preset) ? 'Remove from favourites' : 'Add to favourites'}
              >
                <StarIcon filled={isFavorite(preset)} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function InstrumentPanel({
  instruments: all,
  choice,
  track,
  backing,
  loading,
  saved,
  onChange,
  onPreview,
  favorites,
  onFavoritesChange,
  onClose,
  embedded = false,
}: InstrumentPanelProps) {
  const instruments = track ? all.filter((instrument) => !!instrument.pads === (track.kind === 'drum')) : all;
  // Opens on the first screen, every kind of instrument at hand
  const [view, setView] = useState<View>({ at: 'home' });
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  // The open instrument's preset list: its search and the kind of sound it shows
  const [presetFilter, setPresetFilter] = useState('');
  const [presetKind, setPresetKind] = useState<string | null>(null);

  const synths = instruments.filter((instrument) => instrument.engine === 'melodics-synth');
  const engines = instruments.filter((instrument) => instrument.engine === 'port');
  const sampled = instruments.filter((instrument) => instrument.engine === 'sampler');
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
      const named = `${instrument.name} ${instrument.category}`.toLowerCase().includes(words) ? [{ instrument }] : [];
      // A synth engine's presets by name too
      if (instrument.engine !== 'port') return named;
      return [
        ...named,
        ...instrument.presets
          .filter((preset) => `${preset.name} ${preset.tag ?? ''}`.toLowerCase().includes(words))
          .slice(0, 24)
          .map((preset) => ({ instrument, preset })),
      ];
    });
  }, [instruments, query]);

  const synthCard = (instrument: InstrumentDef, preset: Preset) => {
    const Icon = SYNTH_TAG_ICONS[preset.tag ?? 'Lead'];
    return (
      <Card
        key={`${instrument.id}:${preset.id}`}
        art={instrument.engine === 'port' ? <CategoryArt seed={artSeed(instrument)} /> : <span className="instrument-card-icon">{Icon && <Icon />}</span>}
        name={preset.name}
        detail={instrument.name}
        active={choice?.instrument === instrument.id && choice?.preset === preset.id}
        onClick={() => pick(instrument, preset)}
      />
    );
  };
  const engineCard = (instrument: InstrumentDef) => (
    <Card
      key={instrument.id}
      art={<CategoryArt seed={artSeed(instrument)} />}
      name={instrument.name}
      detail={plural(instrument.presets.length, 'preset')}
      active={choice?.instrument === instrument.id}
      onClick={() => pick(instrument)}
    />
  );
  // A favourite: its preset, with the synth or instrument it comes from
  const favoriteCard = (instrument: InstrumentDef, preset: Preset) => {
    const Icon = instrument.engine === 'melodics-synth' ? SYNTH_TAG_ICONS[preset.tag ?? 'Lead'] : null;
    return (
      <Card
        key={`${instrument.id}:${preset.id}`}
        art={Icon ? <span className="instrument-card-icon">{<Icon />}</span> : <CategoryArt seed={artSeed(instrument)} />}
        name={preset.name}
        detail={instrument.name}
        active={choice?.instrument === instrument.id && choice?.preset === preset.id}
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
      active={choice?.instrument === instrument.id}
      onClick={() => pick(instrument)}
    />
  );

  const current = view.at === 'instrument' ? instruments.find((instrument) => instrument.id === view.id) : undefined;
  const title =
    view.at === 'tag' ? view.tag : view.at === 'category' ? view.category : current ? current.name : (track?.title ?? track?.name ?? 'Instruments');
  const back =
    view.at === 'home'
      ? undefined
      : () => {
          if (view.at === 'instrument' && current?.engine === 'melodics-synth') {
            const preset = current.presets.find((candidate) => candidate.id === choice?.preset);
            setView(preset?.tag ? { at: 'tag', tag: preset.tag } : { at: 'home' });
          } else if (view.at === 'instrument' && current && current.engine === 'sampler') setView({ at: 'category', category: current.category });
          else setView({ at: 'home' });
        };

  const setEffects = (effects: EffectSlot[]) => choice && onChange({ ...choice, effects });

  // Favourites: a preset of an instrument, marked with a star
  const isFavorite = (instrument: InstrumentDef, preset: Preset) =>
    favorites.some((favorite) => favorite.instrument === instrument.id && favorite.preset === preset.id);
  const toggleFavorite = (instrument: InstrumentDef, preset: Preset) =>
    onFavoritesChange(
      isFavorite(instrument, preset)
        ? favorites.filter((favorite) => !(favorite.instrument === instrument.id && favorite.preset === preset.id))
        : [...favorites, { instrument: instrument.id, preset: preset.id }]
    );
  // The favourites that fit here (a drum track takes kits only), newest first
  const favoriteCards = favorites
    .flatMap((favorite) => {
      const instrument = instruments.find((candidate) => candidate.id === favorite.instrument);
      const preset = instrument?.presets.find((candidate) => candidate.id === favorite.preset);
      return instrument && preset ? [{ instrument, preset }] : [];
    })
    .reverse();

  // Another instrument opened: its list starts whole
  const openId = view.at === 'instrument' ? view.id : null;
  useEffect(() => {
    setPresetFilter('');
    setPresetKind(null);
  }, [openId]);

  // The presets the open instrument's arrows step through, as its list shows them
  const steppable = current ? (current.presets.length > MAX_PRESET_BUTTONS ? shownPresets(current.presets, presetFilter, presetKind) : current.presets) : [];
  const stepRef = useRef<(direction: number) => void>(() => undefined);
  stepRef.current = (direction: number) => {
    if (!current || !choice || choice.instrument !== current.id || !steppable.length) return;
    const at = steppable.findIndex((preset) => preset.id === choice.preset);
    const next = steppable[at < 0 ? 0 : Math.min(steppable.length - 1, Math.max(0, at + direction))];
    if (next.id === choice.preset) return;
    onChange(presetChoice(current, next.id));
    onPreview?.();
  };
  // Up and down step through the presets, but never out of a field that takes
  // them (a slider, a list of options); the preset search lets them through
  useEffect(() => {
    if (!openId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const target = event.target instanceof Element ? event.target : null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"], [role="listbox"]');
      if (typing && !target!.classList.contains('instrument-preset-search')) return;
      event.preventDefault();
      stepRef.current(event.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId]);

  return (
    <aside className={`instrument-panel ${embedded ? 'embedded' : ''}`}>
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
            {results.map(({ instrument, preset }) =>
              preset ? synthCard(instrument, preset) : instrument.engine === 'port' ? engineCard(instrument) : sampledCard(instrument)
            )}
          </div>
        ) : view.at === 'home' ? (
          <>
            {track?.original && (
              <CardRow title="This track">
                <Card
                  art={<span className="instrument-card-icon">{TrackSoundIcon()}</span>}
                  name="Original"
                  detail={track.name}
                  active={!choice}
                  onClick={track.original}
                />
              </CardRow>
            )}
            {favoriteCards.length > 0 && (
              <CardRow title="Favourites">{favoriteCards.map(({ instrument, preset }) => favoriteCard(instrument, preset))}</CardRow>
            )}
            {tags.length > 0 && <CardRow title="Synths">
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
            </CardRow>}
            {engines.length > 0 && <CardRow title="Synth engines">{engines.map(engineCard)}</CardRow>}
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
        ) : current && choice && choice.instrument === current.id ? (
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
                <span className="instrument-card-detail">
                  {loading ? 'Loading…' : (current.presets.find((preset) => preset.id === choice.preset)?.name ?? current.category)}
                </span>
              </span>
              {(() => {
                const preset = current.presets.find((candidate) => candidate.id === choice.preset);
                if (!preset) return null;
                const on = isFavorite(current, preset);
                return (
                  <button
                    className={`instrument-icon-btn instrument-favorite ${on ? 'on' : ''}`}
                    onClick={() => toggleFavorite(current, preset)}
                    aria-label={on ? `Remove ${preset.name} from favourites` : `Add ${preset.name} to favourites`}
                    title={on ? 'Remove from favourites' : 'Add to favourites'}
                  >
                    <StarIcon filled={on} />
                  </button>
                );
              })()}
              {choiceEdited(current, choice) && (
                <button className="jam-reset" onClick={() => onChange(presetChoice(current, choice.preset))}>
                  Reset
                </button>
              )}
            </div>

            {!!backing?.length && (
              <>
                <div className="jam-subhead">Backing track</div>
                <div className="instrument-options">
                  {backing.map(({ id, name, muted, onMute }) => (
                    <button
                      key={id}
                      className={`jam-sound-option ${muted ? '' : 'active'}`}
                      aria-pressed={!muted}
                      title={muted ? `Unmute ${name}` : `Mute ${name}`}
                      onClick={() => onMute(!muted)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="jam-subhead">Presets</div>
            {current.presets.length > MAX_PRESET_BUTTONS ? (
              <PresetList
                presets={current.presets}
                chosen={choice.preset}
                filter={presetFilter}
                onFilterChange={setPresetFilter}
                kind={presetKind}
                onKindChange={setPresetKind}
                isFavorite={(preset) => isFavorite(current, preset)}
                onToggleFavorite={(preset) => toggleFavorite(current, preset)}
                onPick={(preset) => onChange(presetChoice(current, preset.id))}
              />
            ) : (
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
            )}

            <Params specs={current.params} values={choice.params} onChange={(params) => onChange({ ...choice, params })} />

            <div className="instrument-effects-head">
              <div className="jam-subhead">Effects</div>
              <JamDropdown
                className="instrument-add-effect"
                placeholder="Add effect"
                value=""
                groups={[{ options: availableEffects().map((kind) => ({ value: kind, label: EFFECTS[kind].label })) }]}
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
