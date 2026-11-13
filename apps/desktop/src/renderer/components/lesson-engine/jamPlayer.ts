import { useEffect, useState } from 'react';
import { JAM_PLAYER_ID, JAM_PLAYER_KEY } from './jamRoomProtocol';

// This app's player, the same in every room and visit: a lasting key kept
// here, and its hash, the lasting id other players see and invite by (only
// the app holding the key takes the id's invites). And the players met in
// rooms, remembered here to invite again, each with the email given for them.

const KEY_KEY = 'melodics.jamPlayer.v1';
const KNOWN_KEY = 'melodics.jamPlayers.v1';
// Players remembered at most, the latest met first
const KNOWN_MAX = 50;

export interface JamPlayerIdentity {
  key: string;
  player: string;
}

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// The lasting key: made once, then kept
function lastingKey(): string {
  const kept = localStorage.getItem(KEY_KEY);
  if (kept && JAM_PLAYER_KEY.test(kept)) return kept;
  const made = hex(crypto.getRandomValues(new Uint8Array(32)));
  localStorage.setItem(KEY_KEY, made);
  return made;
}

// The lasting id of a key, as the room server works it out
export async function jamPlayerIdOf(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return hex(new Uint8Array(digest)).slice(0, 32);
}

let identity: Promise<JamPlayerIdentity> | null = null;
export function jamPlayerIdentity(): Promise<JamPlayerIdentity> {
  if (!identity) {
    const key = lastingKey();
    identity = jamPlayerIdOf(key).then((player) => ({ key, player }));
  }
  return identity;
}

// A player met in a room
export interface JamKnownPlayer {
  player: string;
  name: string;
  color: string;
  // The email given for them; empty until one is
  email: string;
  // When they were last met (ms)
  seen: number;
}

export function loadKnownPlayers(): JamKnownPlayer[] {
  const kept = localStorage.getItem(KNOWN_KEY);
  if (!kept) return [];
  const list: unknown = JSON.parse(kept);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (known): known is JamKnownPlayer =>
      !!known &&
      typeof known.player === 'string' &&
      JAM_PLAYER_ID.test(known.player) &&
      typeof known.name === 'string' &&
      typeof known.color === 'string' &&
      typeof known.email === 'string' &&
      typeof known.seen === 'number'
  );
}

// Every open page's lists hear of a change
const CHANGED = 'melodics-jam-players';
function saveKnownPlayers(list: JamKnownPlayer[]) {
  localStorage.setItem(KNOWN_KEY, JSON.stringify(list.slice(0, KNOWN_MAX)));
  window.dispatchEvent(new Event(CHANGED));
}

// The players in a room now (not this one) remembered, by their name there now
export function rememberPlayers(players: { player?: string; name: string; color: string }[], self: string) {
  const met = players.filter((peer): peer is typeof peer & { player: string } => !!peer.player && peer.player !== self);
  if (!met.length) return;
  const list = loadKnownPlayers();
  const now = Date.now();
  const changed = met.filter((peer) => {
    const known = list.find((entry) => entry.player === peer.player);
    return !known || known.name !== peer.name || known.color !== peer.color;
  });
  if (!changed.length) return;
  const byId = new Map(list.map((known) => [known.player, known]));
  for (const peer of met) {
    byId.set(peer.player, { player: peer.player, name: peer.name, color: peer.color, email: byId.get(peer.player)?.email ?? '', seen: now });
  }
  saveKnownPlayers([...byId.values()].sort((a, b) => b.seen - a.seen));
}

export function setKnownEmail(player: string, email: string) {
  saveKnownPlayers(loadKnownPlayers().map((known) => (known.player === player ? { ...known, email } : known)));
}

// The remembered players, as they change (here or in another page)
export function useKnownPlayers(): JamKnownPlayer[] {
  const [list, setList] = useState(loadKnownPlayers);
  useEffect(() => {
    const reload = () => setList(loadKnownPlayers());
    const onStorage = (event: StorageEvent) => {
      if (event.key === KNOWN_KEY) reload();
    };
    window.addEventListener(CHANGED, reload);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGED, reload);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return list;
}
