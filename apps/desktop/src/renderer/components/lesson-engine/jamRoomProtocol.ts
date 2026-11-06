import type { JamSynthPatch } from './jamSynth';
import type { JamTrackEdit } from './jamTrackEdits';

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
}

// A Daw song as the Daw lobby lists it, with the players editing it now
export interface JamDawSongSummary extends Omit<JamDawSong, 'edit'> {
  editors: { name: string; color: string }[];
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
  playing: boolean;
  players: { name: string; color: string }[];
  full: boolean;
}

// The room's jam, the same for every player in it
export interface JamRoomState {
  song: JamRoomSong;
  // Server time (ms) of the song's first 16th while it plays; null while paused
  startAt: number | null;
  // Where the song stopped (s) while it is paused
  position: number;
  // Backing tracks as edited in the room's grid, by file
  tracks: Record<string, JamTrackEdit>;
}

// The sound a player plays: a preset, kit or reference sound id, and its
// edited settings for a synth preset
export interface JamRoomSound {
  id: string;
  patch?: JamSynthPatch;
}

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
}

// A note on the room's grid: its 16th since the song's first, and its row
export interface JamRoomNote {
  seq: number;
  song: string;
  slot: number;
  note: number;
}

export type JamClientMessage =
  // Joins a Jam room by its key. `create` opens it with that song (a
  // built-in one, or a Daw song offered to rooms) when no room has this key;
  // without it a missing room is reported.
  | {
      t: 'join';
      room: string;
      create?: { visibility: JamRoomVisibility; song: string };
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
  // Whether a Daw song is offered to new Jam rooms
  | { t: 'offer'; song: string; offered: boolean }
  // Whether `code` opens the private room listed as `id`
  | { t: 'check'; id: string; code: string; c: number }
  | { t: 'ping'; c: number }
  | { t: 'state'; state: Omit<JamRoomState, 'song' | 'tracks'> }
  // A Daw song's grid as edited (a Jam room's song stays as it was opened)
  | { t: 'track'; file: string; edit: JamTrackEdit | null }
  | { t: 'peer'; name: string; sound: JamRoomSound | null; need: number }
  | { t: 'signal'; to: string; data: JamSignal }
  | { t: 'note'; note: JamRoomNote }
  | { t: 'cursor'; seq: number; row: number }
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
  | { t: 'state'; state: JamRoomState }
  | { t: 'joined'; peer: JamRoomPeer }
  | { t: 'left'; id: string }
  | { t: 'peer'; peer: JamRoomPeer }
  | { t: 'signal'; from: string; data: JamSignal }
  | { t: 'note'; from: string; note: JamRoomNote }
  | { t: 'cursor'; from: string; seq: number; row: number }
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
