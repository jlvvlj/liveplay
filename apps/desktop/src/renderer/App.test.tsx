import { render, screen } from '@testing-library/react';
import App from './App';

// Mock window.electronAPI
(window as any).electronAPI = {
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
};

// Songs and pieces APIs return empty lists
(global as any).fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve([]),
});

// Instrument Lab is a separate browser client (JSX + ES modules, audio worklets)
jest.mock('./components/instrument-lab/InstrumentLab', () => ({
  InstrumentLab: () => <div>Instrument Lab view</div>,
}));

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
  it('renders the main heading', async () => {
    render(<App />);
    expect(screen.getByText(/Melodics-like MVP — DEV/i)).toBeInTheDocument();
    await screen.findByText('Choose a Lesson');
  });

  it('displays navigation buttons', async () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Lessons' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Instrument Lab' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    await screen.findByText('Choose a Lesson');
  });

  it('shows the lesson selector by default', async () => {
    render(<App />);
    expect(await screen.findByText('Choose a Lesson')).toBeInTheDocument();
  });
});
