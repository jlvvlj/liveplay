/// <reference types="vite/client" />
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { LessonPlayer } from '../desktop/src/renderer/components/lesson-engine/LessonPlayer';
import { JamLobby, type JamRoomEntry } from '../desktop/src/renderer/components/lesson-engine/JamLobby';
import { JamLobbyConnection } from '../desktop/src/renderer/components/lesson-engine/jamLobbyConnection';
import type { JamRoomEnd } from '../desktop/src/renderer/components/lesson-engine/jamRoom';
import { JAM_SONGS } from '../desktop/src/renderer/components/lesson-engine/jamSongs';
import { JAM_SOUND_PRESETS } from '../desktop/src/renderer/components/lesson-engine/jamSynth';
import {
  JAM_ROOM_CODE,
  JAM_ROOM_PATH,
  type JamRoomSummary,
} from '../desktop/src/renderer/components/lesson-engine/jamRoomProtocol';
import '../desktop/src/renderer/styles/index.css';

// Rooms to play together: VITE_JAM_ROOM_URL when the app is built to use a
// separate room server (npm run start:jam-rooms), else the server it came from
const jamRoomServer =
  import.meta.env.VITE_JAM_ROOM_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${JAM_ROOM_PATH}`;

// The room in the address (?room=KEY), if any
function roomInAddress(): JamRoomEntry | null {
  const key = new URLSearchParams(location.search).get('room')?.toUpperCase();
  return key && JAM_ROOM_CODE.test(key) ? { key } : null;
}

// The jam app: the lobby of live rooms, and the Jam in the room it leads to.
// The rooms list is followed the whole time, so the lobby is up to date the
// moment the player comes back to it.
function JamApp() {
  const [rooms, setRooms] = useState<JamRoomSummary[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [lobby, setLobby] = useState<JamLobbyConnection | null>(null);
  useEffect(() => {
    const connection = new JamLobbyConnection(jamRoomServer, (next) => {
      setUnreachable(next === null);
      if (next) setRooms(next);
    });
    setLobby(connection);
    return () => connection.close();
  }, []);

  const [room, setRoom] = useState<JamRoomEntry | null>(roomInAddress);
  const [ended, setEnded] = useState<JamRoomEnd | null>(null);
  useEffect(() => {
    const onPop = () => {
      setEnded(null);
      setRoom(roomInAddress());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const enter = (entry: JamRoomEntry) => {
    history.pushState(null, '', `?room=${entry.key}`);
    setEnded(null);
    setRoom(entry);
  };
  const backToLobby = (reason: JamRoomEnd | null = null) => {
    history.replaceState(null, '', location.pathname);
    setEnded(reason);
    setRoom(null);
  };

  return (
    <div className="app app-jam">
      <main className="app-main">
        {room ? (
          <LessonPlayer
            key={room.key}
            lesson={JAM_SONGS[0]}
            jamOnly
            jamSounds={JAM_SOUND_PRESETS}
            jamSongs={JAM_SONGS}
            jamRoomServer={jamRoomServer}
            jamRoomJoin={room}
            onJamRoomEnd={backToLobby}
            onComplete={() => backToLobby()}
          />
        ) : (
          <JamLobby
            rooms={rooms}
            unreachable={unreachable}
            check={(id, code) => lobby?.check(id, code) ?? Promise.resolve(null)}
            songs={JAM_SONGS}
            onEnter={enter}
            ended={ended}
          />
        )}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <JamApp />
  </React.StrictMode>
);
