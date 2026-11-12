import type { InstrumentChoice } from './instruments/types';
import type { JamTrackEdit } from './jamTrackEdits';
import type { Lesson } from '../../types/lesson';
import type { JamLessonChoice } from './jamLessonRooms';

// Messages between jam players and the room server (server/jamRooms.ts), as
// JSON over a WebSocket, and between players over their direct connections.
// A room is a Jam room (players on the highway over one song, picked by the
// player who opens it) or a Daw song's room (players editing the song's grid
// together, kept by the server as they edit).

// An open room is listed with its key, so anyone can join it from the lobby;
// a private room is listed without it, and joining takes its code
export type JamRoomVisibility = 'open' | 'private';

// A room's song: a built-in song (jamSongs.ts) or a Daw song, with what
// every player needs to play it: its backing track (jamTracks.ts) and the
// highway's rows moved up `transpose` semitones
export interface JamRoomSong {
  id: string;
  title: string;
  bpm: number;
  file: string;
  transpose: number;
}

// A song made in the Daw, as the server keeps it
export interface JamDawSong extends JamRoomSong {
  // Its track's notes as edited; null while they are its backing track's own
  edit: JamTrackEdit | null;
  // Offered to new Jam rooms
  offered: boolean;
  created: number;
  // An imported Ableton project's tracks (its `file` is then JAM_ABLETON_FILE)
  ableton?: JamAbletonSong;
}

// A Daw song imported from an Ableton project, as the full app's Ableton
// import reads it: each track's lesson (each step a slice of the track's
// export), on the song's own time from its first beat, and the song's length
export interface JamAbletonSong {
  seconds: number;
  tracks: JamAbletonTrack[];
}
export interface JamAbletonTrack {
  name: string;
  // The track's export, Opus in WebM (GET /jam-audio/<audio>)
  audio: string;
  lesson: Lesson;
}
export const JAM_ABLETON_FILE = 'ableton';

// A Daw song as the lobbies list it, with the players editing it now and its
// tracks a lesson room can learn, any of them together (jamLessonRooms.ts)
export interface JamDawSongSummary extends Omit<JamDawSong, 'edit' | 'ableton'> {
  editors: { name: string; color: string }[];
  tracks: JamLessonChoice[];
}

// A lesson room's lesson: some of its song's tracks (jamLessonChoices' ids),
// by name
export interface JamRoomLesson {
  tracks: string[];
  name: string;
}

// A Jam room as the lobby lists it
export interface JamRoomSummary {
  id: string;
  // The name of the player who opened the room
  host: string;
  visibility: JamRoomVisibility;
  // The key to join with: an open room's; null for a private room
  key: string | null;
  song: JamRoomSong;
  // A lesson room's lesson; null for a Jam room
  lesson: JamRoomLesson | null;
  playing: boolean;
  players: { name: string; color: string }[];
  full: boolean;
}

// The room's jam, the same for every player in it
export interface JamRoomState {
  song: JamRoomSong;
  lesson: JamRoomLesson | null;
  // Server time (ms) of the song's first 16th while it plays; null while paused
  startAt: number | null;
  // Where the song stopped (s) while it is paused
  position: number;
  // Backing tracks as edited in the room's grid, by file
  tracks: Record<string, JamTrackEdit>;
}

// The sound a player plays: an instrument, the preset it started from, and
// its parameters and effects as the player set them
export type JamRoomSound = InstrumentChoice;

export interface JamRoomPeer {
  id: string;
  // The name on the player's ship; a numbered default until they give one
  name: string;
  color: string;
  sound: JamRoomSound | null;
  // How long before a note sounds this player must have it (s): its
  // scheduling margin and audio output latency
  need: number;
  // Where the player's ship is: 0 on the top row, 1 per row down, in between
  // while it moves; null until it is on the highway
  row: number | null;
  // Where the player is in a Daw song; null until they say
  presence?: JamDawPresence | null;
}

// Where a player is in a Daw song: the track whose editor they have open and
// the section it shows, and their pointer: over a track's lane (at a 16th of
// the song), or over the open editor's grid (at a 16th, on a part's pitch)
export interface JamDawPresence {
  track: string | null;
  page: number;
  pointer: JamDawPointer | null;
}
export type JamDawPointer =
  | { on: 'lane'; track: string; step: number }
  | { on: 'grid'; step: number; part: number; pitch: number };

// A note on the room's grid: its 16th since the song's first, its row and velocity
// (velocity 1-127). A note with a `length` (16ths) ends by itself; one
// without is held until a note with `off` comes: the same slot and row, and
// how long it was held (16ths).
export interface JamRoomNote {
  seq: number;
  song: string;
  slot: number;
  note: number;
  velocity?: number;
  length?: number;
  off?: number;
}

export type JamClientMessage =
  // Joins a Jam room by its key. `create` opens it with that song (a
  // built-in one, or a Daw song offered to rooms) when no room has this key;
  // without it a missing room is reported.
  | {
      t: 'join';
      room: string;
      create?: { visibility: JamRoomVisibility; song: string; lesson?: string[] };
      name: string;
      sound: JamRoomSound | null;
      need: number;
    }
  // Joins the room where a Daw song is edited
  | { t: 'edit'; song: string; name: string; sound: JamRoomSound | null; need: number }
  // Leaving the room, so the others and the lobby hear of it at once
  | { t: 'leave' }
  // The lobby: the Jam rooms and the Daw songs, now and whenever they change
  | { t: 'lobby' }
  // A new Daw song: a copy of a built-in song (its id), or empty at `bpm`
  | { t: 'newSong'; c: number; title: string; from: string | null; bpm: number }
  // A Daw song imported from an Ableton project, its audio already sent (POST /jam-audio)
  | { t: 'importSong'; c: number; title: string; bpm: number; ableton: JamAbletonSong }
  // Whether a Daw song is offered to new Jam rooms
  | { t: 'offer'; song: string; offered: boolean }
  // Whether `code` opens the private room listed as `id`
  | { t: 'check'; id: string; code: string; c: number }
  | { t: 'ping'; c: number }
  | { t: 'state'; state: Omit<JamRoomState, 'song' | 'lesson' | 'tracks'> }
  // A Daw song's grid as edited, and its tempo (a Jam room's song stays as it was opened)
  | { t: 'track'; file: string; edit: JamTrackEdit | null }
  | { t: 'tempo'; bpm: number }
  | { t: 'peer'; name: string; sound: JamRoomSound | null; need: number }
  | { t: 'signal'; to: string; data: JamSignal }
  | { t: 'note'; note: JamRoomNote }
  | { t: 'cursor'; seq: number; row: number }
  | { t: 'presence'; presence: JamDawPresence }
  | { t: 'probe'; to: string; c: number; back: boolean };

export type JamServerMessage =
  | { t: 'welcome'; id: string; visibility: JamRoomVisibility; state: JamRoomState; peers: JamRoomPeer[] }
  | { t: 'full' }
  | { t: 'missing' }
  | { t: 'rooms'; rooms: JamRoomSummary[] }
  | { t: 'songs'; songs: JamDawSongSummary[] }
  // The new Daw song's id; null when it could not be made
  | { t: 'songMade'; c: number; id: string | null }
  | { t: 'checked'; c: number; ok: boolean }
  | { t: 'pong'; c: number; s: number }
  // `by`: the player whose edit of a Daw song's grid this is
  | { t: 'state'; state: JamRoomState; by?: string }
  | { t: 'joined'; peer: JamRoomPeer }
  | { t: 'left'; id: string }
  | { t: 'peer'; peer: JamRoomPeer }
  | { t: 'signal'; from: string; data: JamSignal }
  | { t: 'note'; from: string; note: JamRoomNote }
  | { t: 'cursor'; from: string; seq: number; row: number }
  | { t: 'presence'; from: string; presence: JamDawPresence }
  | { t: 'probe'; from: string; c: number; back: boolean };

// WebRTC set-up passed between two players through the server
export type JamSignal = { sdp: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit };

// Between two players directly
export type JamDirectMessage =
  | { t: 'note'; note: JamRoomNote }
  | { t: 'cursor'; seq: number; row: number }
  | { t: 'ping'; c: number }
  | { t: 'pong'; c: number };

export const JAM_ROOM_PATH = '/jam-room';
export const JAM_ROOM_MAX_PLAYERS = 8;
export const JAM_ROOM_CODE = /^[A-Z0-9]{4,8}$/;
export const JAM_ROOM_NAME_MAX = 20;
export const JAM_SONG_TITLE_MAX = 40;
