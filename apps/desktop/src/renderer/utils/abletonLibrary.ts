import { AbletonProject, AbletonTrack, ProjectFile, audioTrackFromAnalysis } from './abletonImport';

/**
 * Remembers Ableton project folders across reloads. The browser keeps a
 * handle to each picked folder (in IndexedDB); the project is re-read from
 * that folder when opened, so nothing is copied or uploaded and re-exports
 * are picked up. After a restart the browser may ask once to allow reading
 * the folder again; that request is made from the click that opens it.
 */

// The File System Access API parts this uses; TypeScript's DOM types don't
// include them yet.
type ReadPermission = { mode: 'read' };
interface FolderHandle extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission(descriptor: ReadPermission): Promise<PermissionState>;
  requestPermission(descriptor: ReadPermission): Promise<PermissionState>;
}
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

export interface SavedProject {
  id: string;
  name: string; // the folder's name
  handle: FileSystemDirectoryHandle;
  addedAt: number;
}

/** Folder remembering needs the File System Access API (Chrome, Edge). */
export const canRememberFolders = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

const DB_NAME = 'melodics';
const STORE = 'ableton-projects';
const ANALYSES = 'audio-analyses'; // detected hits per exported audio track

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(ANALYSES)) db.createObjectStore(ANALYSES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  storeName = STORE
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(storeName, mode).objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function listSavedProjects(): Promise<SavedProject[]> {
  const all = await withStore<SavedProject[]>('readonly', (store) => store.getAll());
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function removeSavedProject(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}

/**
 * Asks for a project folder and remembers it. Picking a folder that is
 * already remembered returns that entry instead of adding a duplicate.
 * Resolves to null if the picker is dismissed.
 */
export async function pickAndSaveProject(): Promise<SavedProject | null> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker!({ id: 'ableton-project', mode: 'read' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
  for (const saved of await listSavedProjects()) {
    if (await saved.handle.isSameEntry(handle)) return saved;
  }
  const project: SavedProject = { id: crypto.randomUUID(), name: handle.name, handle, addedAt: Date.now() };
  await withStore('readwrite', (store) => store.put(project));
  return project;
}

/** Makes sure the folder can be read; must be called from a click. */
export async function allowReading(project: SavedProject): Promise<void> {
  const handle = project.handle as FolderHandle;
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return;
  if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') {
    throw new Error(`Reading ${project.name} was not allowed.`);
  }
}

/** Every file in the folder, with its path inside it. */
export async function readFolder(handle: FileSystemDirectoryHandle, prefix = ''): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  for await (const entry of (handle as FolderHandle).values()) {
    const path = prefix + entry.name;
    if (entry.kind === 'directory') {
      files.push(...(await readFolder(entry as FileSystemDirectoryHandle, path + '/')));
    } else {
      files.push({ path, file: await (entry as FileSystemFileHandle).getFile() });
    }
  }
  return files;
}

type AudioAnalysis = Parameters<typeof audioTrackFromAnalysis>[2];

/**
 * Hits detected in an audio track's export, as a playable track. The server
 * analyses the export once; the result is kept in the browser, keyed by the
 * exact file, so a re-export is analysed again.
 */
export async function detectAudioTrack(project: AbletonProject, name: string): Promise<AbletonTrack> {
  const file = project.exports.get(name);
  if (!file) throw new Error(`${name} has no exported audio in this folder.`);
  const key = [project.name, name, file.size, file.lastModified, project.tempo].join('|');
  let analysis = await withStore<AudioAnalysis | undefined>('readonly', (store) => store.get(key), ANALYSES);
  if (!analysis) {
    const response = await fetch(`/api/songs/analyze-audio?bpm=${project.tempo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: file,
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error ?? `Analysis failed (${response.status})`);
    analysis = body as AudioAnalysis;
    await withStore('readwrite', (store) => store.put(analysis, key), ANALYSES);
  }
  if (analysis.events.length === 0) throw new Error(`No hits were found in ${name}.`);
  return audioTrackFromAnalysis(project, name, analysis);
}
