/// <reference types="vite/client" />
import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { LessonPlayer } from '../desktop/src/renderer/components/lesson-engine/LessonPlayer';
import { JamLobby, type JamLobbyTrack, type JamRoomEntry } from '../desktop/src/renderer/components/lesson-engine/JamLobby';
import { DawLobby } from '../desktop/src/renderer/components/lesson-engine/DawLobby';
import { JamHome } from '../desktop/src/renderer/components/lesson-engine/JamHome';
import { JamLobbyConnection } from '../desktop/src/renderer/components/lesson-engine/jamLobbyConnection';
import type { JamRoomEnd } from '../desktop/src/renderer/components/lesson-engine/jamRoom';
import { JAM_SONGS } from '../desktop/src/renderer/components/lesson-engine/jamSongs';
import { JAM_SOUND_PRESETS } from '../desktop/src/renderer/components/lesson-engine/jamSynth';
import {
  JAM_ROOM_CODE,
  JAM_ROOM_PATH,
  type JamDawSongSummary,
  type JamRoomSummary,
} from '../desktop/src/renderer/components/lesson-engine/jamRoomProtocol';
import '../desktop/src/renderer/styles/index.css';

// Rooms to play together: VITE_JAM_ROOM_URL when the app is built to use a
// separate room server (npm run start:jam-rooms), else the server it came from
const jamRoomServer =
  import.meta.env.VITE_JAM_ROOM_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${JAM_ROOM_PATH}`;

// Where the address leads: home, a section's lobby (?daw, ?jam), a Daw song
// being edited (?song=ID) or a Jam room (?room=KEY)
type Place =
  | { at: 'home' }
  | { at: 'daw' }
  | { at: 'jam' }
  | { at: 'song'; id: string }
  | { at: 'room'; entry: JamRoomEntry };

function placeInAddress(): Place {
  const query = new URLSearchParams(location.search);
  const key = query.get('room')?.toUpperCase();
  if (key && JAM_ROOM_CODE.test(key)) return { at: 'room', entry: { key } };
  const song = query.get('song')?.toUpperCase();
  if (song && JAM_ROOM_CODE.test(song)) return { at: 'song', id: song };
  if (query.has('daw')) return { at: 'daw' };
  if (query.has('jam')) return { at: 'jam' };
  return { at: 'home' };
}

const addressOf = (place: Place): string => {
  switch (place.at) {
    case 'home':
      return location.pathname;
    case 'daw':
    case 'jam':
      return `?${place.at}`;
    case 'song':
      return `?song=${place.id}`;
    case 'room':
      return `?room=${place.entry.key}`;
  }
};

// The jam app: home, the Daw's songs and the Jam's rooms, and a song's grid or
// a room's highway they lead to. The lists are followed the whole time, so a
// lobby is up to date the moment the player comes back to it.
function JamApp() {
  const [place, setPlace] = useState<Place>(placeInAddress);
  const [ended, setEnded] = useState<JamRoomEnd | null>(null);
  const [rooms, setRooms] = useState<JamRoomSummary[] | null>(null);
  const [songs, setSongs] = useState<JamDawSongSummary[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [lobby, setLobby] = useState<JamLobbyConnection | null>(null);
  useEffect(() => {
    const connection = new JamLobbyConnection(
      jamRoomServer,
      (next) => {
        setUnreachable(next === null);
        if (next) setRooms(next);
        // Losing the server says more than why the last room ended
        else setEnded(null);
      },
      setSongs
    );
    setLobby(connection);
    return () => connection.close();
  }, []);

  useEffect(() => {
    const onPop = () => {
      setEnded(null);
      setPlace(placeInAddress());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (next: Place) => {
    history.pushState(null, '', addressOf(next));
    setEnded(null);
    setPlace(next);
  };
  // Back from a song or a room to its section's lobby
  const backTo = (section: 'daw' | 'jam', reason: JamRoomEnd | null = null) => {
    history.replaceState(null, '', addressOf({ at: section }));
    setEnded(reason);
    setPlace({ at: section });
  };

  // A new room's tracks: the built-in songs, then the Daw songs offered to rooms
  const tracks = useMemo<JamLobbyTrack[]>(
    () => [
      ...JAM_SONGS.map((song) => ({ id: song.id, title: song.title, bpm: song.bpm, daw: false })),
      ...(songs ?? []).filter((song) => song.offered).map((song) => ({ id: song.id, title: song.title, bpm: song.bpm, daw: true })),
    ],
    [songs]
  );

  const player = (key: string, join: React.ComponentProps<typeof LessonPlayer>['jamRoomJoin'], section: 'daw' | 'jam') => (
    <LessonPlayer
      key={key}
      lesson={JAM_SONGS[0]}
      jamOnly
      jamSection={section}
      jamSounds={JAM_SOUND_PRESETS}
      jamSongs={JAM_SONGS}
      jamRoomServer={jamRoomServer}
      jamRoomJoin={join}
      onJamRoomEnd={(reason) => backTo(section, reason)}
      onComplete={() => backTo(section)}
    />
  );

  return (
    <div className="app app-jam">
      <main className="app-main">
        {place.at === 'home' && <JamHome songs={songs?.length ?? null} rooms={rooms?.length ?? null} onOpen={(at) => go({ at })} />}
        {place.at === 'daw' && (
          <DawLobby
            songs={songs}
            unreachable={unreachable}
            builtIns={JAM_SONGS}
            onOpen={(id) => go({ at: 'song', id })}
            onNew={(title, from, bpm) => lobby?.newSong(title, from, bpm) ?? Promise.resolve(null)}
            onOffer={(id, offered) => lobby?.offer(id, offered)}
            onBack={() => go({ at: 'home' })}
            ended={ended}
          />
        )}
        {place.at === 'jam' && (
          <JamLobby
            rooms={rooms}
            unreachable={unreachable}
            check={(id, code) => lobby?.check(id, code) ?? Promise.resolve(null)}
            tracks={tracks}
            onEnter={(entry) => go({ at: 'room', entry })}
            onBack={() => go({ at: 'home' })}
            ended={ended}
          />
        )}
        {place.at === 'song' && player(`song-${place.id}`, { key: place.id, edit: true }, 'daw')}
        {place.at === 'room' && player(`room-${place.entry.key}`, place.entry, 'jam')}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <JamApp />
  </React.StrictMode>
);
