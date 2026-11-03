import { registerInstrumentLab } from './instrument-lab';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { SeparationManager } from './separation-manager';
import { analyzeAudio } from './analyze-audio';
import { createMergedStem, getOrCreateStemLesson, listMergedStems, updateStemLesson, resetStemLesson } from './stem-lesson';
import { StemName } from './songs';
import { createSong, deleteSong, getSong, listSongs, resetInterruptedJobs, updateSong } from './songs';

const PORT = 3001;
const repoRoot = path.resolve(__dirname, '..');
const stemsRoot = path.join(repoRoot, 'audio', 'stems');

const app = express();
const manager = new SeparationManager(repoRoot);
registerInstrumentLab(app, repoRoot, getSong);

// Upload an MP3. Body is the raw file; title comes from the filename query param.
app.post('/api/songs', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
  try {
    const filename = String(req.query.filename ?? '');
    if (!filename.toLowerCase().endsWith('.mp3')) {
      res.status(400).json({ error: 'Only .mp3 files are supported.' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Empty upload.' });
      return;
    }
    const title = path.basename(filename).replace(/\.mp3$/i, '');
    const song = await createSong({ title, sourcePath: '' });
    const songDir = path.join(stemsRoot, song.id);
    await fs.promises.mkdir(songDir, { recursive: true });
    const sourcePath = path.join(songDir, 'source.mp3');
    await fs.promises.writeFile(sourcePath, req.body);
    const updated = await updateSong(song.id, { sourcePath });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Hit detection for one audio file (e.g. an Ableton audio track's export).
// Body: the WAV; query: bpm. Lives under /api/songs so the dev proxy reaches it.
app.post('/api/songs/analyze-audio', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'No audio received.' });
      return;
    }
    res.json(await analyzeAudio(repoRoot, req.body, Number(req.query.bpm)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/songs/:id/separate', async (req, res) => {
  const song = await getSong(req.params.id);
  if (!song) {
    res.status(404).json({ error: 'Song not found.' });
    return;
  }
  await manager.enqueue(song.id);
  res.status(202).json({ ok: true });
});

app.get('/api/songs', async (_req, res) => {
  const songs = await listSongs();
  res.json(
    songs.map((song) => ({
      ...song,
      progress: manager.getProgress(song.id),
    }))
  );
});

app.get('/api/songs/:id', async (req, res) => {
  const song = await getSong(req.params.id);
  if (!song) {
    res.status(404).json({ error: 'Song not found.' });
    return;
  }
  res.json({ ...song, progress: manager.getProgress(song.id) });
});

app.post('/api/songs/:id/stem-lesson', async (req, res) => {
  const song = await getSong(req.params.id);
  if (!song) {
    res.status(404).json({ error: 'Song not found.' });
    return;
  }
  try {
    const lesson = await getOrCreateStemLesson(song, String(req.query.stem), repoRoot);
    res.json(lesson);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/songs/:id/merged-stems', async (req, res) => {
  const song = await getSong(req.params.id);
  if (!song) {
    res.status(404).json({ error: 'Song not found.' });
    return;
  }
  try {
    res.json(await listMergedStems(song, repoRoot));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/songs/:id/merged-stems', express.json({ limit: '1mb' }), async (req, res) => {
  const song = await getSong(req.params.id);
  if (!song) {
    res.status(404).json({ error: 'Song not found.' });
    return;
  }
  try {
    const stems = Array.isArray(req.body?.stems) ? req.body.stems : [];
    const merged = await createMergedStem(song, stems as StemName[], repoRoot);
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/songs/:id/stem-lesson', express.json({ limit: '10mb' }), async (req, res) => {
  const song = await getSong(req.params.id);
  if (!song) {
    res.status(404).json({ error: 'Song not found.' });
    return;
  }
  try {
    const lesson = await updateStemLesson(song, String(req.query.stem), req.body);
    res.json(lesson);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/songs/:id/stem-lesson', async (req, res) => {
  try {
    await resetStemLesson(req.params.id, String(req.query.stem), repoRoot);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/songs/:id', async (req, res) => {
  manager.cancel(req.params.id);
  await deleteSong(req.params.id, stemsRoot);
  res.json({ ok: true });
});

async function start() {
  await resetInterruptedJobs();
  app.listen(PORT, () => {
    console.log(`Melodics API server listening on http://localhost:${PORT}`);
  });
}

void start();
