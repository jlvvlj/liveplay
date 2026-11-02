import { render, screen, fireEvent } from '@testing-library/react';
import { LessonPlayer } from './LessonPlayer';
import { Lesson } from '../../types/lesson';

// Mock window.electronAPI
(window as any).electronAPI = {
  midi: {
    list: jest.fn().mockResolvedValue([]),
    selectDevice: jest.fn().mockResolvedValue(undefined),
    onEvent: jest.fn(),
    removeEventListener: jest.fn(),
  },
  mapping: {
    getAll: jest.fn().mockResolvedValue([]),
  },
};

// Mock Tone.js
jest.mock('tone', () => {
  class MockInstrument {
    volume = { value: 0 };
    toDestination() {
      return this;
    }
    triggerAttackRelease = jest.fn();
    dispose = jest.fn();
  }
  class MockPlayer extends MockInstrument {
    fadeOut = 0;
    loaded = false;
    start = jest.fn();
    stop = jest.fn();
  }
  return {
    start: jest.fn().mockResolvedValue(undefined),
    now: jest.fn().mockReturnValue(0),
    Transport: {
      bpm: { value: 120 },
      start: jest.fn(),
      stop: jest.fn(),
      pause: jest.fn(),
      schedule: jest.fn(),
      cancel: jest.fn(),
    },
    Synth: MockInstrument,
    PolySynth: MockInstrument,
    MembraneSynth: MockInstrument,
    Sampler: MockInstrument,
    Player: MockPlayer,
    ToneAudioBuffer: class {
      dispose = jest.fn();
    },
    Frequency: () => ({ toNote: () => 'C4' }),
  };
});

const mockLesson: Lesson = {
  id: 'test-lesson',
  title: 'Test Lesson Title',
  instrument: 'pads',
  bpm: 100,
  steps: [
    { tick: 0, note: 36, dur: 120, velocity: 100 },
    { tick: 480, note: 38, dur: 120, velocity: 100 },
  ],
  loop: {
    startTick: 0,
    endTick: 960,
  },
  metadata: {
    difficulty: 2,
    description: 'Test lesson description',
  },
};

describe('LessonPlayer', () => {
  it('renders lesson title', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    expect(screen.getByText('Test Lesson Title')).toBeInTheDocument();
  });

  it('displays lesson metadata', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    expect(screen.getByText('100 BPM')).toBeInTheDocument();
    expect(screen.getByText('Lv.2')).toBeInTheDocument();
  });

  it('shows practice mode tabs', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    expect(screen.getByRole('button', { name: 'Free' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wait' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('shows the start game button', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    expect(screen.getByTitle('Start Game')).toBeInTheDocument();
  });

  it('shows score and recent hits in the key bindings panel', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    fireEvent.click(screen.getByTitle('Key Bindings'));
    expect(screen.getByText('Key Bindings')).toBeInTheDocument();
    expect(screen.getByText('Score')).toBeInTheDocument();
    expect(screen.getByText('Recent Hits')).toBeInTheDocument();
  });
});
