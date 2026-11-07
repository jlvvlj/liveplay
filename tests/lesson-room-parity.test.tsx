import { render, screen, fireEvent } from '@testing-library/react';
import { defaultLessonKeys, LESSON_DEFAULT_KEYS } from '../apps/desktop/src/renderer/components/lesson-engine/lessonKeys';
import { jamLessonTiming } from '../apps/desktop/src/renderer/components/lesson-engine/NoteHighway';
import { JamSettingsPanel } from '../apps/desktop/src/renderer/components/lesson-engine/JamSettingsPanel';
import { JAM_BACKING_TOP_DB } from '../apps/desktop/src/renderer/components/lesson-engine/jamBackingMixer';
import { JAM_LESSON_HIT_LIFT_DB, jamLessonHitsDb } from '../apps/desktop/src/renderer/components/lesson-engine/jamLessonVoices';
import { NoteHighway, type HighwayMode } from '../apps/desktop/src/renderer/components/lesson-engine/NoteHighway';

jest.mock('tone', () => ({}));

describe('default lesson keys', () => {
  it('gives the lanes a r s t g k n e i from the top lane down', () => {
    expect(LESSON_DEFAULT_KEYS.slice(0, 9)).toEqual(['a', 'r', 's', 't', 'g', 'k', 'n', 'e', 'i']);
    // A lesson room's lanes run from the highest note at the top
    expect(defaultLessonKeys([38, 37, 36])).toEqual({ a: 38, r: 37, s: 36 });
  });

  it('has a different key for every lane it can give one', () => {
    expect(new Set(LESSON_DEFAULT_KEYS).size).toBe(LESSON_DEFAULT_KEYS.length);
    const lanes = Array.from({ length: 40 }, (_, i) => 100 - i);
    expect(Object.keys(defaultLessonKeys(lanes))).toHaveLength(LESSON_DEFAULT_KEYS.length);
  });
});

describe('lesson room hits', () => {
  it('play at their track\'s loudness and the backing\'s full level, lifted above it', () => {
    expect(jamLessonHitsDb(1)).toBeCloseTo(JAM_BACKING_TOP_DB + JAM_LESSON_HIT_LIFT_DB);
    // A quiet track (a loudness gain of 2) plays its hits 6 dB louder, as its backing
    expect(jamLessonHitsDb(2) - jamLessonHitsDb(1)).toBeCloseTo(6.02, 1);
    // At the default Notes volume (75%), a hit is still above its own part in the backing
    expect(JAM_LESSON_HIT_LIFT_DB + 20 * Math.log10(0.75)).toBeGreaterThan(3);
  });

  it('show how they were played, as lesson mode\'s notes do', () => {
    expect(jamLessonTiming(undefined)).toBe('');
    expect(jamLessonTiming({ accuracy: 'played', deltaMs: 0 })).toBe('played');
    expect(jamLessonTiming({ accuracy: 'miss', deltaMs: 0 })).toBe('missed');
    expect(jamLessonTiming({ accuracy: 'good', deltaMs: 30 })).toBe('on-time');
    expect(jamLessonTiming({ accuracy: 'early', deltaMs: -80 })).toBe('early');
    expect(jamLessonTiming({ accuracy: 'late', deltaMs: 90 })).toBe('late');
  });
});

describe('a lesson room\'s highway in Wait mode', () => {
  // jsdom lays nothing out: a highway 1000 px wide
  beforeAll(() => {
    jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500);
  });
  afterAll(() => jest.restoreAllMocks());

  it('is the jam highway with the ship: the step waited for at the ship, the played ones filled in', () => {
    const steps = [0, 480, 960, 1440].map((tick, i) => ({ tick, note: 36 + (i % 2), dur: 120, velocity: 100 }));
    const { container } = render(
      <NoteHighway
        steps={steps}
        currentTime={500}
        bpm={60}
        mode="jam"
        jamLesson={{
          loopMs: 4000,
          hits: new Map([['0:0', { accuracy: 'played' as const, deltaMs: 0 }]]),
          current: '0:1',
          stepped: true,
          clock: '1 / 4',
        }}
        highestOnTop
      />
    );
    expect(container.querySelector('.note-highway.jam')).toBeTruthy();
    expect(container.querySelector('.jam-lesson-note.played')).toBeTruthy();
    expect(container.querySelector('.jam-lesson-note.current')).toBeTruthy();
    // None of lesson mode's own tiles
    expect(container.querySelector('.note.scrolling-note, .note-highway:not(.jam)')).toBeNull();
    expect(screen.getByText('1 / 4')).toBeTruthy();
  });
});

describe('a lesson room\'s judged steps', () => {
  beforeAll(() => {
    jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500);
  });
  afterAll(() => jest.restoreAllMocks());

  it('draw early and late as lesson mode does: dimmed where due, a copy moved to where it was played', () => {
    const steps = [0, 480, 960].map((tick) => ({ tick, note: 36, dur: 120, velocity: 100 }));
    const { container } = render(
      <NoteHighway
        steps={steps}
        currentTime={400}
        bpm={120}
        mode="jam"
        jamLesson={{
          loopMs: 1500,
          hits: new Map([
            ['0:0', { accuracy: 'perfect' as const, deltaMs: 10 }],
            ['0:1', { accuracy: 'late' as const, deltaMs: 120 }],
            ['0:2', { accuracy: 'miss' as const, deltaMs: 0 }],
          ]),
        }}
        highestOnTop
      />
    );
    const late = container.querySelector<HTMLElement>('.jam-lesson-note.late:not(.ghost-hit)')!;
    const copy = container.querySelector<HTMLElement>('.jam-lesson-note.ghost-hit.late')!;
    expect(late.style.opacity).toBe('0.35');
    // 120 ms late, at 0.6 px a millisecond
    expect(parseFloat(copy.style.left) - parseFloat(late.style.left)).toBeCloseTo(72);
    // On time and missed have no copy
    expect(container.querySelectorAll('.jam-lesson-note.ghost-hit')).toHaveLength(1);
    expect(container.querySelector('.jam-lesson-note.on-time')).toBeTruthy();
    expect(container.querySelector('.jam-lesson-note.missed')).toBeTruthy();
  });
});

describe('a lesson room\'s sidebar', () => {
  const score = { totalSteps: 10, hits: 2, misses: 1, perfectHits: 1, goodHits: 1, accuracy: 20, totalPoints: 200, maxPoints: 1000 };
  const panel = (mode: HighwayMode, overrides: Record<string, unknown> = {}) => {
    const lesson = {
      score,
      lanes: null,
      autoPlay: 0,
      onAutoPlayChange: jest.fn(),
      mode,
      game: false,
      onModeChange: jest.fn(),
      tempo: 90,
      onTempoChange: jest.fn(),
      speed: 0.5,
      onSpeedChange: jest.fn(),
      metronome: 0,
      onMetronomeChange: jest.fn(),
      paused: false,
      onTogglePause: jest.fn(),
      onRestart: jest.fn(),
      onStartGame: jest.fn(),
      ...overrides,
    };
    render(
      <JamSettingsPanel
        section="jam"
        songs={[]}
        songId=""
        onSongChange={jest.fn()}
        lesson={lesson}
        view="highway"
        instrument={null}
        onOpenInstruments={jest.fn()}
        holdDivisions={[4, 8, 16, 32]}
        holdDivision={16}
        onHoldDivisionChange={jest.fn()}
        holdTriplet={false}
        onHoldTripletChange={jest.fn()}
        swing={0.5}
        onSwingChange={jest.fn()}
        notesVolume={0.75}
        onNotesVolumeChange={jest.fn()}
        backingVolume={1}
        onBackingVolumeChange={jest.fn()}
        title="Drums — Chip Run"
        bpm={90}
        midiActive={false}
        lastMidiNote={null}
        showKeys={false}
        onToggleKeys={jest.fn()}
        labelMode="letters"
        onLabelModeChange={jest.fn()}
        onClose={jest.fn()}
      />
    );
    return lesson;
  };

  it('has lesson mode\'s modes, and Jam plays on the room\'s clock with its tempo and hold repeat', () => {
    const lesson = panel('jam');
    for (const mode of ['Free', 'Wait', 'Play', 'Jam', 'Start']) expect(screen.getByRole('button', { name: mode })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Jam' }).className).toContain('active');
    expect(screen.getByLabelText('Tempo')).toBeTruthy();
    expect(screen.getByText('Metronome')).toBeTruthy();
    for (const division of ['4', '8', '16', '32']) expect(screen.getByRole('button', { name: division })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));
    expect(lesson.onModeChange).toHaveBeenCalledWith('wait');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(lesson.onStartGame).toHaveBeenCalled();
  });

  it('sets the room\'s tempo once the slider is let go', () => {
    const lesson = panel('jam');
    const tempo = screen.getByLabelText('Tempo');
    fireEvent.change(tempo, { target: { value: '120' } });
    expect(lesson.onTempoChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(tempo);
    expect(lesson.onTempoChange).toHaveBeenCalledWith(120);
  });

  it('shows Play mode\'s speed, and no tempo or hold repeat off the room\'s clock', () => {
    panel('play');
    expect(screen.getByText('Speed')).toBeTruthy();
    expect(screen.queryByLabelText('Tempo')).toBeNull();
    expect(screen.queryByRole('button', { name: '16' })).toBeNull();
  });

  it('offers nothing in Wait mode that needs a clock', () => {
    panel('wait');
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
    expect(screen.queryByText('Metronome')).toBeNull();
    expect(screen.queryByText('Auto-play')).toBeNull();
    // Lesson mode's lane collapse belongs to its own tiles, which a room never shows
    expect(screen.queryByTitle('Collapse lanes')).toBeNull();
  });

  it('offers no tempo for a song that keeps its own', () => {
    panel('jam', { tempo: null });
    expect(screen.queryByLabelText('Tempo')).toBeNull();
  });
});
