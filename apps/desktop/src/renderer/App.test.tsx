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

describe('App', () => {
  it('renders the main heading', () => {
    render(<App />);
    const heading = screen.getByText(/Melodics-like MVP — DEV/i);
    expect(heading).toBeInTheDocument();
  });

  it('displays MIDI Device Setup section', () => {
    render(<App />);
    const deviceSetup = screen.getByText(/MIDI Device Setup/i);
    expect(deviceSetup).toBeInTheDocument();
  });
});
