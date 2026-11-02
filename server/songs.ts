import { prisma } from './db';
import { Song as PrismaSong } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

export type StemName = 'drums' | 'bass' | 'vocals' | 'other';
export type SongStatus = 'imported' | 'queued' | 'separating' | 'ready' | 'error';

export interface Song {
  id: string;
  title: string;
  sourcePath: string;
  status: SongStatus;
  error: string | null;
  duration: number | null;
  stems: Record<StemName, string> | null; // paths relative to the repo audio/ dir
  createdAt: string;
}

function toSong(row: PrismaSong): Song {
  const hasStems = row.drumsPath && row.bassPath && row.vocalsPath && row.otherPath;
  return {
    id: row.id,
    title: row.title,
    sourcePath: row.sourcePath,
    status: row.status as SongStatus,
    error: row.error,
    duration: row.duration,
    stems: hasStems
      ? {
          drums: row.drumsPath!,
          bass: row.bassPath!,
          vocals: row.vocalsPath!,
          other: row.otherPath!,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createSong(data: { title: string; sourcePath: string }): Promise<Song> {
  const row = await prisma.song.create({
    data: { title: data.title, sourcePath: data.sourcePath, status: 'imported' },
  });
  return toSong(row);
}

export async function listSongs(): Promise<Song[]> {
  const rows = await prisma.song.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toSong);
}

export async function getSong(id: string): Promise<Song | null> {
  const row = await prisma.song.findUnique({ where: { id } });
  return row ? toSong(row) : null;
}

export async function updateSong(
  id: string,
  data: Partial<{
    status: SongStatus;
    error: string | null;
    duration: number;
    sourcePath: string;
    drumsPath: string;
    bassPath: string;
    vocalsPath: string;
    otherPath: string;
  }>
): Promise<Song> {
  const row = await prisma.song.update({ where: { id }, data });
  return toSong(row);
}

export async function deleteSong(id: string, stemsRootDir: string): Promise<void> {
  await prisma.song.delete({ where: { id } });
  const dir = path.join(stemsRootDir, id);
  if (fs.existsSync(dir)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// Jobs don't survive a server restart; anything left mid-flight is an error.
export async function resetInterruptedJobs(): Promise<void> {
  await prisma.song.updateMany({
    where: { status: { in: ['queued', 'separating'] } },
    data: { status: 'error', error: 'Separation was interrupted by a server restart.' },
  });
}
