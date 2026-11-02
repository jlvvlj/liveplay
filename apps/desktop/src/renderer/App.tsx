import { useState } from 'react';
import { InstrumentLab } from './components/instrument-lab/InstrumentLab';
import { MidiDeviceSelector } from './components/midi/MidiDeviceSelector';
import { LessonSelector } from './components/lesson-engine/LessonSelector';
import { LessonPlayer } from './components/lesson-engine/LessonPlayer';
import { JAM_SONGS } from './components/lesson-engine/jamSongs';
import { JAM_SOUND_PRESETS } from './components/lesson-engine/jamSynth';
import { SongPracticePlayer } from './components/song-practice/SongPracticePlayer';
import { StemSoundEditor } from './components/stem-editor/StemSoundEditor';
import { Lesson } from './types/lesson';
import { Song } from './types/song';

type AppView = 'lessons' | 'jam' | 'playing' | 'settings' | 'song-practice' | 'stem-editor' | 'instrument-lab';

function App() {
  const [view, setView] = useState<AppView>('lessons');
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);

  const handleSongSelect = (song: Song) => {
    setSelectedSong(song);
    setView('song-practice');
  };

  const handleSongEdit = (song: Song) => {
    setSelectedSong(song);
    setView('stem-editor');
  };

  const handleLessonSelect = (lesson: Lesson) => {
    console.log('[App] Lesson selected:', {
      id: lesson.id,
      title: lesson.title,
      hasSamples: !!lesson.samples,
      samplesKeys: lesson.samples ? Object.keys(lesson.samples) : [],
      samples: lesson.samples,
    });
    setSelectedLesson(lesson);
    setView('playing');
  };

  const handleBackToLessons = () => {
    setView('lessons');
    setSelectedLesson(null);
  };

  return (
    <div className={`app ${view === 'jam' ? 'app-jam' : ''}`}>
      {view !== 'jam' && (
      <header className="app-header">
        <h1>Melodics-like MVP — DEV</h1>
        <p>Interactive MIDI Lessons Platform</p>
        <nav className="app-nav">
          <button onClick={() => setView('lessons')} className={view === 'lessons' ? 'active' : ''}>
            Lessons
          </button>
          <button onClick={() => setView('jam')}>
            Jam
          </button>
          <button onClick={() => { setSelectedSong(null); setView('instrument-lab'); }} className={view === 'instrument-lab' ? 'active' : ''}>
            Instrument Lab
          </button>
          <button onClick={() => setView('settings')} className={view === 'settings' ? 'active' : ''}>
            Settings
          </button>
        </nav>
      </header>
      )}
      <main className="app-main">
        {view === 'settings' && (
          <div className="settings-page">
            <h2>Settings</h2>
            <MidiDeviceSelector />
          </div>
        )}
        {view === 'lessons' && (
          <LessonSelector
            onLessonSelect={handleLessonSelect}
            onSongSelect={handleSongSelect}
            onSongEdit={handleSongEdit}
            onSongInstrumentEdit={(song) => { setSelectedSong(song); setView('instrument-lab'); }}
          />
        )}
        {view === 'jam' && (
          <LessonPlayer
            key={JAM_SONGS[0].id}
            lesson={JAM_SONGS[0]}
            jamOnly
            jamSounds={JAM_SOUND_PRESETS}
            jamSongs={JAM_SONGS}
            onComplete={() => setView('lessons')}
          />
        )}
        {view === 'instrument-lab' && (
          <InstrumentLab song={selectedSong} onExit={handleBackToLessons} />
        )}
        {view === 'playing' && selectedLesson && (
          <LessonPlayer lesson={selectedLesson} onComplete={handleBackToLessons} />
        )}
        {view === 'song-practice' && selectedSong && (
          <SongPracticePlayer song={selectedSong} onExit={handleBackToLessons} />
        )}
        {view === 'stem-editor' && selectedSong && (
          <StemSoundEditor
            song={selectedSong}
            onExit={handleBackToLessons}
            onStartLesson={handleLessonSelect}
          />
        )}
      </main>
    </div>
  );
}

export default App;
