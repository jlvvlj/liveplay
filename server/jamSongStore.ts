import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { JamDawSong } from '../apps/desktop/src/renderer/components/lesson-engine/jamRoomProtocol';
import { validJamTrackEdit } from '../apps/desktop/src/renderer/components/lesson-engine/jamTrackEdits';

// The Daw's songs, one JSON file each in `dir` (on the hosted jam, a Fly
// volume). All are read when the server starts; a changed song is written
// shortly after its last change, to a temporary file renamed over the old one.

const WRITE_MS = 500;
const ID_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const songFile = (dir: string, id: string) => path.join(dir, `${id}.json`);

function readSong(file: string): JamDawSong {
  const song = JSON.parse(fs.readFileSync(file, 'utf8')) as JamDawSong;
  if (song.edit !== null && !validJamTrackEdit(song.file, song.edit)) {
    throw new Error(`${file}: its edit does not match its track ${song.file}`);
  }
  return song;
}

export function createJamSongStore(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const songs = new Map<string, JamDawSong>();
  for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const song = readSong(path.join(dir, name));
    songs.set(song.id, song);
  }
  const writes = new Map<string, ReturnType<typeof setTimeout>>();
  // Every new song is made later than all the others, even within one millisecond,
  // so newest first is always the order they were made in
  let lastCreated = Math.max(0, ...[...songs.values()].map((song) => song.created));

  const write = (id: string) => {
    writes.delete(id);
    const song = songs.get(id);
    if (!song) return;
    const file = songFile(dir, id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(song));
    fs.renameSync(`${file}.tmp`, file);
  };
  const changed = (id: string) => {
    const pending = writes.get(id);
    if (pending) clearTimeout(pending);
    writes.set(id, setTimeout(() => write(id), WRITE_MS));
  };

  const newId = () => {
    for (;;) {
      const id = Array.from(randomBytes(8), (byte) => ID_LETTERS[byte % ID_LETTERS.length]).join('');
      if (!songs.has(id)) return id;
    }
  };

  return {
    // Newest first
    list: (): JamDawSong[] => [...songs.values()].sort((a, b) => b.created - a.created),
    get: (id: string): JamDawSong | undefined => songs.get(id),
    add(song: Omit<JamDawSong, 'id' | 'created'>): JamDawSong {
      lastCreated = Math.max(Date.now(), lastCreated + 1);
      const made: JamDawSong = { ...song, id: newId(), created: lastCreated };
      songs.set(made.id, made);
      write(made.id);
      return made;
    },
    update(id: string, change: Partial<Pick<JamDawSong, 'edit' | 'offered' | 'bpm' | 'file'>>): void {
      const song = songs.get(id);
      if (!song) return;
      songs.set(id, { ...song, ...change });
      changed(id);
    },
    // Writes every pending change now
    flush(): void {
      for (const [id, timer] of writes) {
        clearTimeout(timer);
        write(id);
      }
    },
  };
}

export type JamSongStore = ReturnType<typeof createJamSongStore>;
