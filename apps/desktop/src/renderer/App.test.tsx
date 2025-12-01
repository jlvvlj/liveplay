import { render, screen } from '@testing-library/react';
import App from './App';

// Mock window.electronAPI
(global as any).window = {
  electronAPI: {
    midi: {
      list: jest.fn().mockResolvedValue([]),
      selectDevice: jest.fn().mockResolvedValue(undefined),
      onEvent: jest.fn(),
      removeEventListener: jest.fn(),
    },
    mapping: {
      get: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
      getAll: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
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

describe('App', () => {
  it('renders the main heading', () => {
    render(<App />);
    const heading = screen.getByText(/Melodics-like MVP — DEV/i);
    expect(heading).toBeInTheDocument();
  });

  it('displays navigation buttons', () => {
    render(<App />);
    expect(screen.getByText('MIDI Setup')).toBeInTheDocument();
    expect(screen.getByText('Lessons')).toBeInTheDocument();
  });

  it('shows MIDI Device Setup by default', () => {
    render(<App />);
    const deviceSetup = screen.getByText(/MIDI Device Setup/i);
    expect(deviceSetup).toBeInTheDocument();
  });

  it('shows continue to lessons button', () => {
    render(<App />);
    expect(screen.getByText(/Continue to Lessons/i)).toBeInTheDocument();
  });
});
