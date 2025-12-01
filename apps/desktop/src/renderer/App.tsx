import { MidiDeviceSelector } from './components/midi/MidiDeviceSelector';

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Melodics-like MVP — DEV</h1>
        <p>Interactive MIDI Lessons Platform</p>
      </header>
      <main className="app-main">
        <MidiDeviceSelector />
      </main>
    </div>
  );
}

export default App;
