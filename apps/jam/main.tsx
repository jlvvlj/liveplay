import React from 'react';
import ReactDOM from 'react-dom/client';
import { LessonPlayer } from '../desktop/src/renderer/components/lesson-engine/LessonPlayer';
import { JAM_SONGS } from '../desktop/src/renderer/components/lesson-engine/jamSongs';
import { JAM_SOUND_PRESETS } from '../desktop/src/renderer/components/lesson-engine/jamSynth';
import '../desktop/src/renderer/styles/index.css';

// The jam app: the desktop app's Jam tab on its own, with nothing to go back to
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="app app-jam">
      <main className="app-main">
        <LessonPlayer lesson={JAM_SONGS[0]} jamOnly jamSounds={JAM_SOUND_PRESETS} jamSongs={JAM_SONGS} />
      </main>
    </div>
  </React.StrictMode>
);
