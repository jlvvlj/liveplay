import { useState } from 'react';
import { MidiDeviceSelector } from './components/midi/MidiDeviceSelector';
import { LessonSelector } from './components/lesson-engine/LessonSelector';
import { LessonPlayer } from './components/lesson-engine/LessonPlayer';
import { Lesson } from './types/lesson';

type AppView = 'setup' | 'lessons' | 'playing';

function App() {
  const [view, setView] = useState<AppView>('setup');
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);

  const handleLessonSelect = (lesson: Lesson) => {
    setSelectedLesson(lesson);
    setView('playing');
  };

  const handleBackToLessons = () => {
    setView('lessons');
    setSelectedLesson(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Melodics-like MVP — DEV</h1>
        <p>Interactive MIDI Lessons Platform</p>
        <nav className="app-nav">
          <button onClick={() => setView('setup')} className={view === 'setup' ? 'active' : ''}>
            MIDI Setup
          </button>
          <button onClick={() => setView('lessons')} className={view === 'lessons' ? 'active' : ''}>
            Lessons
          </button>
        </nav>
      </header>
      <main className="app-main">
        {view === 'setup' && (
          <div>
            <MidiDeviceSelector />
            <div className="setup-actions">
              <button className="btn-continue" onClick={() => setView('lessons')}>
                Continue to Lessons →
              </button>
            </div>
          </div>
        )}
        {view === 'lessons' && (
          <LessonSelector onLessonSelect={handleLessonSelect} />
        )}
        {view === 'playing' && selectedLesson && (
          <div>
            <button className="btn-back" onClick={handleBackToLessons}>
              ← Back to Lessons
            </button>
            <LessonPlayer lesson={selectedLesson} />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
