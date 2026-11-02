import express, { Express } from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'node:http';

type SourceSong = { id: string; title: string; sourcePath: string; stems?: { drums?: string } | null };

// The new editor owns its documents and analyses. The existing song, stems,
// sound edits and practice lessons are read-only to this bridge.
export function registerInstrumentLab(
  app: Express,
  repoRoot: string,
  getSong: (id: string) => Promise<SourceSong | null>,
  origin = process.env.INSTRUMENT_LAB_ORIGIN || 'http://127.0.0.1:5186',
) {
  app.post('/api/songs/:id/instrument-lab', async (req, res) => {
    try {
      const song = await getSong(String(req.params.id));
      if (!song) return void res.status(404).json({ error: 'Song not found.' });
      const existing = await fetch(`${origin}/api/song-projects/${encodeURIComponent(song.id)}`);
      if (existing.ok) return void res.json(await existing.json());
      if (existing.status !== 404) throw new Error('Instrument Lab is unavailable. Please retry.');
      const bytes = await fs.readFile(song.sourcePath);
      const query = new URLSearchParams({ filename: song.title + path.extname(song.sourcePath) });
      const response = await fetch(`${origin}/api/song-projects/${encodeURIComponent(song.id)}?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      const result = await response.json();
      res.status(response.status).json(result);
    } catch (error) {
      console.error('Instrument Lab bridge:', error);
      res.status(502).json({ error: 'Could not open Instrument Lab. Check that the analysis service is running, then retry.' });
    }
  });

  app.post('/api/songs/:id/instrument-lab/drums', async (req, res) => {
    try {
      const song = await getSong(String(req.params.id));
      if (!song) return void res.status(404).json({error: 'Song not found.'});
      if (!song.stems?.drums) return void res.status(409).json({error: 'Wait for this song’s drum stem to finish separating, then open Drums again.'});
      const endpoint = `${origin}/api/song-projects/${encodeURIComponent(song.id)}?engine=drum`;
      const existing = await fetch(endpoint);
      if (existing.ok) return void res.json(await existing.json());
      if (existing.status !== 404) throw new Error('Instrument Lab unavailable');
      const audioRoot = path.resolve(repoRoot, 'audio');
      const stemPath = path.resolve(audioRoot, song.stems.drums.replace(/^\/audio\//, ''));
      if (!stemPath.startsWith(audioRoot + path.sep)) throw new Error('Invalid drum stem path');
      const bytes = await fs.readFile(stemPath);
      const response = await fetch(endpoint + '&filename=' + encodeURIComponent(song.title + ' · Drums.wav'), {
        method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: bytes,
      });
      res.status(response.status).json(await response.json());
    } catch (error) {
      console.error('Instrument Lab drums:', error);
      res.status(502).json({error: 'Could not open the drum stem. Check the analysis service and retry.'});
    }
  });

  // A separate API namespace prevents collisions with the existing songs API.
  app.use('/api/instruments', (req, res) => {
    const upstream = http.request(new URL('/api' + req.url, origin), {
      method: req.method,
      headers: { ...req.headers, host: new URL(origin).host },
    }, (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'Instrument Lab is unavailable. Please retry.' });
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  app.use('/instrument-lab/engine', express.static(path.join(repoRoot, 'instrument-lab/engine')));
  app.use('/instrument-lab', express.static(path.join(repoRoot, 'instrument-lab/dist')));
}
