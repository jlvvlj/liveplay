import { render, screen } from '@testing-library/react';
import { LessonPlayer } from './LessonPlayer';
import { Lesson } from '../../types/lesson';

// Mock window.electronAPI
(global as any).window = {
  electronAPI: {
    midi: {
      onEvent: jest.fn(),
      removeEventListener: jest.fn(),
    },
  },
};

// Mock Tone.js
jest.mock('tone', () => ({
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
}));

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
    expect(screen.getByText('pads')).toBeInTheDocument();
    expect(screen.getByText('100 BPM')).toBeInTheDocument();
    expect(screen.getByText('Level 2')).toBeInTheDocument();
  });

  it('shows playback controls', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    expect(screen.getByText('Playback')).toBeInTheDocument();
    expect(screen.getByText('Start')).toBeInTheDocument();
  });

  it('shows practice mode controls', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    expect(screen.getByText('Practice Mode')).toBeInTheDocument();
    expect(screen.getByText(/Loop Enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/Speed:/i)).toBeInTheDocument();
    expect(screen.getByText(/Auto-BPM/i)).toBeInTheDocument();
    expect(screen.getByText(/Wait Mode/i)).toBeInTheDocument();
  });

  it('displays score section', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    expect(screen.getByText('Score')).toBeInTheDocument();
    expect(screen.getByText('Accuracy')).toBeInTheDocument();
    expect(screen.getByText('Points')).toBeInTheDocument();
    expect(screen.getByText('Hits')).toBeInTheDocument();
  });

  it('shows recent hits section', () => {
    render(<LessonPlayer lesson={mockLesson} />);
    expect(screen.getByText('Recent Hits')).toBeInTheDocument();
  });
});
