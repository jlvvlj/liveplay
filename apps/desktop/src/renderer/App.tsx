function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Melodics-like MVP — DEV</h1>
        <p>Interactive MIDI Lessons Platform</p>
      </header>
      <main className="app-main">
        <div className="welcome-section">
          <h2>Welcome to Melodics MVP</h2>
          <p>
            This is a cross-platform desktop application for interactive MIDI lessons.
          </p>
          <ul>
            <li>✓ Real-time MIDI input and feedback</li>
            <li>✓ Practice Mode with loop, slow playback, Auto-BPM, and Wait</li>
            <li>✓ Progress tracking and leveling system</li>
            <li>✓ Lesson editor and import</li>
          </ul>
        </div>
      </main>
    </div>
  );
}

export default App;
