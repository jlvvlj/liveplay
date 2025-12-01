import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders the main heading', () => {
    render(<App />);
    const heading = screen.getByText(/Melodics-like MVP — DEV/i);
    expect(heading).toBeInTheDocument();
  });

  it('displays welcome message', () => {
    render(<App />);
    const welcome = screen.getByText(/Welcome to Melodics MVP/i);
    expect(welcome).toBeInTheDocument();
  });

  it('lists core features', () => {
    render(<App />);
    expect(screen.getByText(/Real-time MIDI input and feedback/i)).toBeInTheDocument();
    expect(screen.getByText(/Practice Mode/i)).toBeInTheDocument();
    expect(screen.getByText(/Progress tracking/i)).toBeInTheDocument();
  });
});
