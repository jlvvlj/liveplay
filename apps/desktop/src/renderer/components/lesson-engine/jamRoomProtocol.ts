import type { JamSynthPatch } from './jamSynth';
import type { JamTrackEdit } from './LessonPlayer';

// Messages between jam players and the room server (server/jamRooms.ts), as
// JSON over a WebSocket, and between players over their direct connections.

// The room's jam, the same for every player in it
export interface JamRoomState {
  songId: string;
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
  | { t: 'join'; room: string; name: string; state: JamRoomState; sound: JamRoomSound | null; need: number }
  | { t: 'ping'; c: number }
  | { t: 'state'; state: Omit<JamRoomState, 'tracks'> }
  | { t: 'track'; file: string; edit: JamTrackEdit | null }
  | { t: 'peer'; name: string; sound: JamRoomSound | null; need: number }
  | { t: 'signal'; to: string; data: JamSignal }
  | { t: 'note'; note: JamRoomNote }
  | { t: 'cursor'; seq: number; row: number }
  | { t: 'probe'; to: string; c: number; back: boolean };

export type JamServerMessage =
  | { t: 'welcome'; id: string; state: JamRoomState; peers: JamRoomPeer[] }
  | { t: 'full' }
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
