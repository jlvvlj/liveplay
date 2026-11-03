/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { LessonPlayer } from '../desktop/src/renderer/components/lesson-engine/LessonPlayer';
import { JAM_SONGS } from '../desktop/src/renderer/components/lesson-engine/jamSongs';
import { JAM_SOUND_PRESETS } from '../desktop/src/renderer/components/lesson-engine/jamSynth';
import { JAM_ROOM_PATH } from '../desktop/src/renderer/components/lesson-engine/jamRoomProtocol';
import '../desktop/src/renderer/styles/index.css';

// Rooms to play together: VITE_JAM_ROOM_URL when the app is built to use a
// separate room server (npm run start:jam-rooms), else the server it came from
const jamRoomServer =
  import.meta.env.VITE_JAM_ROOM_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${JAM_ROOM_PATH}`;

// The jam app: the desktop app's Jam tab on its own, with nothing to go back to
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="app app-jam">
      <main className="app-main">
        <LessonPlayer
          lesson={JAM_SONGS[0]}
          jamOnly
          jamSounds={JAM_SOUND_PRESETS}
          jamSongs={JAM_SONGS}
          jamRoomServer={jamRoomServer}
        />
      </main>
    </div>
  </React.StrictMode>
);
