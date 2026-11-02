import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerInstrumentLab } from './instrument-lab';

test('track bridge reads only the saved original, reopens linked work and proxies lab audio', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'melodics-bridge-'));
  const sourcePath = path.join(folder, 'source.mp3');
  await fs.writeFile(sourcePath, 'original recording');
  await fs.mkdir(path.join(folder, 'instrument-lab/dist'), {recursive:true});
  await fs.mkdir(path.join(folder, 'instrument-lab/engine'), {recursive:true});
  await fs.writeFile(path.join(folder, 'instrument-lab/dist/index.html'), '<h1>editor</h1>');
  await fs.writeFile(path.join(folder, 'instrument-lab/engine/worklet.mjs'), '// synth engine');
  const song = Object.freeze({id:'song-1', title:'My song', sourcePath});
  let uploads = 0;
  let linked = false;
  const project = {id:'preserved-project', revision:7, status:'ready'};
  const lab = express();
  lab.get('/api/song-projects/song-1', (_req,res) => res.status(linked?200:404).json(linked?project:{}));
  lab.post('/api/song-projects/song-1', express.raw({type:()=>true}), (req,res) => {
    assert.equal(req.query.filename, 'My song.mp3');
    assert.equal(req.body.toString(), 'original recording');
    uploads++; linked=true; res.json(project);
  });
  lab.get('/api/projects/p/audio/source.wav', (_req,res) => res.type('audio/wav').send('audio bytes'));
  const upstream = lab.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const app = express();
  registerInstrumentLab(app, folder, async (id) => id === song.id ? song : null, `http://127.0.0.1:${(upstream.address() as any).port}`);
  app.get('/api/songs', (_req,res) => res.json([song]));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await Promise.all([new Promise<void>((r)=>server.close(()=>r())),new Promise<void>((r)=>upstream.close(()=>r()))]);
    await fs.rm(folder,{recursive:true,force:true});
  });
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const open=()=>fetch(origin+'/api/songs/song-1/instrument-lab',{method:'POST',body:JSON.stringify({sourcePath:'/not-authorized.mp3'})});
  assert.deepEqual(await (await open()).json(),project);
  assert.deepEqual(await (await open()).json(),project);
  assert.equal(uploads,1);
  assert.equal((await fetch(origin+'/api/songs/missing/instrument-lab',{method:'POST'})).status,404);
  assert.deepEqual(await (await fetch(origin+'/api/songs')).json(),[song]);
  assert.equal(await (await fetch(origin+'/api/instruments/projects/p/audio/source.wav')).text(),'audio bytes');
  assert.match(await (await fetch(origin+'/instrument-lab/')).text(),/editor/);
  assert.match(await (await fetch(origin+'/instrument-lab/engine/worklet.mjs')).text(),/synth engine/);
});

test('drum bridge imports only the stored drum stem and keeps melodic work separate', async (t) => {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'melodics-drums-'));
  await fs.mkdir(path.join(folder,'audio/stems/song-1'),{recursive:true});
  await fs.writeFile(path.join(folder,'audio/stems/song-1/drums.wav'),'stereo drum stem');
  const song={id:'song-1',title:'Example',sourcePath:'/never-read-original.mp3',stems:{drums:'stems/song-1/drums.wav'}};
  const lab=express();let linked=false;let uploads=0;
  lab.get('/api/song-projects/song-1',(req,res)=>{
    assert.equal(req.query.engine,'drum');res.status(linked?200:404).json(linked?{id:'drum-project',engine:'drum'}:{});
  });
  lab.post('/api/song-projects/song-1',express.raw({type:()=>true}),(req,res)=>{
    assert.equal(req.query.engine,'drum');assert.equal(req.body.toString(),'stereo drum stem');
    linked=true;uploads++;res.json({id:'drum-project',engine:'drum'});
  });
  const upstream=lab.listen(0,'127.0.0.1');await once(upstream,'listening');
  const app=express();registerInstrumentLab(app,folder,async id=>id===song.id?song:id==='unfinished'?{...song,stems:null}:null,`http://127.0.0.1:${(upstream.address() as any).port}`);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);await fs.rm(folder,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  for(let i=0;i<2;i++){const response=await fetch(origin+'/api/songs/song-1/instrument-lab/drums',{method:'POST'});assert.equal(response.status,200);assert.equal((await response.json()).id,'drum-project');}
  assert.equal(uploads,1);assert.equal(await fs.readFile(path.join(folder,'audio/stems/song-1/drums.wav'),'utf8'),'stereo drum stem');
  assert.equal((await fetch(origin+'/api/songs/unfinished/instrument-lab/drums',{method:'POST'})).status,409);
  assert.equal((await fetch(origin+'/api/songs/missing/instrument-lab/drums',{method:'POST'})).status,404);
});
