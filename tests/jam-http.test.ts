/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';
import { createJamHttp, jamAudioExists } from '../server/jamHttp';
import { createJamSongStore } from '../server/jamSongStore';

describe('the jam server\'s HTTP side', () => {
  let server: http.Server;
  let base: string;
  let songsDir: string;
  let songs: ReturnType<typeof createJamSongStore>;

  beforeEach(async () => {
    songsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-http-'));
    songs = createJamSongStore(songsDir);
    const handle = createJamHttp({ songsDir, songs, repoRoot: process.cwd() });
    server = http.createServer((req, res) =>
      handle(req, res, () => {
        res.statusCode = 404;
        res.end('next');
      })
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(songsDir, { recursive: true, force: true });
  });

  it('keeps audio by its content\'s hash and serves it back', async () => {
    const audio = Buffer.from('opus in webm');
    const sent = await fetch(`${base}/jam-audio`, { method: 'POST', body: audio });
    const { id } = await sent.json();
    expect(id).toBe(createHash('sha256').update(audio).digest('hex'));
    expect(jamAudioExists(songsDir, id)).toBe(true);
    // The same audio again is the same file
    expect((await (await fetch(`${base}/jam-audio`, { method: 'POST', body: audio })).json()).id).toBe(id);

    const got = await fetch(`${base}/jam-audio/${id}`);
    expect(got.headers.get('content-type')).toBe('audio/webm');
    expect(got.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(audio);
    expect((await fetch(`${base}/jam-audio/${'0'.repeat(64)}`)).status).toBe(404);
    expect(jamAudioExists(songsDir, '../songs')).toBe(false);
  });

  it('refuses empty audio', async () => {
    expect((await fetch(`${base}/jam-audio`, { method: 'POST', body: '' })).status).toBe(400);
  });

  it('serves a Daw song as kept, and passes everything else on', async () => {
    const made = songs.add({ title: 'Night', bpm: 120, file: 'empty-120.wav', transpose: 0, edit: null, offered: false });
    expect(await (await fetch(`${base}/jam-songs/${made.id}`)).json()).toMatchObject({ id: made.id, title: 'Night' });
    expect((await fetch(`${base}/jam-songs/NOSUCH12`)).status).toBe(404);
    expect(await (await fetch(`${base}/elsewhere`)).text()).toBe('next');
  });
});
