import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {encodeWav,DEFAULT_PATCH} from '../engine/synth.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,accept){for(let i=0;i<300;i++){const v=await fn();if(accept(v))return v;await wait(30)}throw Error('Timed out')}

test('Demucs pipeline runs separation before fitting, preserves prior analysis and immutable stem audio',{timeout:25000},async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'demucs-api-')),data=path.join(temp,'data');
 const id='11111111-1111-4111-8111-111111111111',samId='22222222-2222-4222-8222-222222222222';
 const folder=path.join(data,id);await fs.mkdir(folder,{recursive:true});
 const wav=Buffer.from(encodeWav(Float32Array.from({length:22050},(_,i)=>Math.sin(i*.03)*.1),22050));
 const original={id,title:'Recording',uploadFile:'upload.wav',status:'ready',revision:4,engine:'melodic',documentFile:'original.json'};
 await fs.writeFile(path.join(folder,'upload.wav'),wav);
 await fs.writeFile(path.join(folder,'project.json'),JSON.stringify(original));
 await fs.writeFile(path.join(folder,'original.json'),JSON.stringify({duration:1,parts:[],analysis:{warnings:[]}}));
 await fs.mkdir(path.join(data,samId));
 await fs.writeFile(path.join(data,samId,'project.json'),JSON.stringify({id:samId,samSourceProjectId:id,status:'ready',engine:'melodic'}));
 const script=path.join(temp,'processor.mjs');
 await fs.writeFile(script,`#!${process.execPath}
import fs from 'node:fs/promises';import path from 'node:path';
const a=process.argv.slice(2), input=a[a.indexOf('--input')+1], output=a[a.indexOf('--output')+1];
await fs.appendFile(${JSON.stringify(path.join(temp,'calls.jsonl'))},JSON.stringify(a)+'\\n');
if(a.includes('-i')){await fs.copyFile(a[a.indexOf('-i')+1],a.at(-1));process.exit(0)}
if(a.includes('--script')){
 if(a[a.indexOf('--model')+1]!=='htdemucs_ft')throw Error('Wrong model');
 await new Promise(r=>setTimeout(r,350));await fs.mkdir(output,{recursive:true});
 for(const name of ['bass','drums','other','vocals'])await fs.copyFile(input,path.join(output,name+'.wav'));
 console.log(JSON.stringify({type:'progress',value:1}));process.exit(0);
}
if(!a[0].endsWith('demucs_stems.py'))throw Error('Unexpected legacy analyser');
for(const name of ['bass','drums','other','vocals'])await fs.access(path.join(output,'demucs',name+'.wav'));
const part={id:'instrument-1',name:'Bass',engine:'melodic',patch:${JSON.stringify(DEFAULT_PATCH)},notes:[{pitch:48,start:.1,end:.5,velocity:90}],referenceFile:'instrument-1-reference.wav',referenceWaveform:[.1,.2]};
await fs.copyFile(path.join(output,'demucs/bass.wav'),path.join(output,part.referenceFile));
await fs.writeFile(path.join(output,'result.json'),JSON.stringify({engine:'mixed',duration:1,parts:[part],analysis:{notes:1,warnings:[]},separation:{provider:'demucs-lab'}}));
`,{mode:0o755});
 const server=spawn(process.execPath,[path.join(root,'server/index.mjs')],{env:{...process.env,NODE_ENV:'production',INSTRUMENT_LAB_PORT:'0',INSTRUMENT_LAB_DATA:data,INSTRUMENT_LAB_PYTHON:script,FFMPEG_PATH:script,UV_PATH:script},stdio:['ignore','pipe','pipe']});
 let logs='';server.stdout.on('data',c=>logs+=c);server.stderr.on('data',c=>logs+=c);
 t.after(async()=>{if(server.exitCode===null){const end=once(server,'exit');server.kill('SIGTERM');await end}await fs.rm(temp,{recursive:true,force:true})});
 const base=await until(()=>logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0],Boolean);
 const call=async(url,body,method='POST')=>{const r=await fetch(base+url,body===undefined?undefined:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 for(const range of [[0,5],[-1,1],[1,0],[0,.1],'all'])assert.equal((await call('/api/projects/'+id+'/demucs',{range})).status,400);
 const job=await call('/api/projects/'+samId+'/demucs',{range:[0,1]});assert.equal(job.status,202);assert.equal(job.body.analysisSourceProjectId,id);
 assert.equal((await call('/api/projects/'+id+'/demucs',{})).status,409);
 const endpoint='/api/projects/'+job.body.id;
 const done=await until(async()=>(await call(endpoint)).body,p=>['ready','error'].includes(p.status));assert.equal(done.status,'ready',logs+JSON.stringify(done));
 assert.equal(done.result.parts.length,1);assert.equal(done.analyses.length,1);
 assert.equal((await call(endpoint+'/analyze-instruments',{})).body.analyses.length,1,'Opening must not start legacy full-mix drum analysis');
 const calls=(await fs.readFile(path.join(temp,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.length,3);assert.ok(calls[0].includes('-ss'));assert.ok(calls[1].includes('--script'));assert.ok(calls[2][0].endsWith('demucs_stems.py'));
 const ref=done.result.parts[0].referenceFile, bytes=await fs.readFile(path.join(data,done.id,ref));
 const edited=await call(endpoint+'/edit',{revision:0,partId:'instrument-1',notes:[{pitch:50,start:.2,end:.7,velocity:100}]},'PUT');
 assert.equal(edited.status,200);assert.equal(edited.body.result.parts[0].referenceFile,ref);
 assert.deepEqual(await fs.readFile(path.join(data,done.id,ref)),bytes);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,'project.json'))),original);
 const cancelledJob=await call('/api/projects/'+id+'/demucs',{});
 assert.equal((await call('/api/projects/'+cancelledJob.body.id+'/cancel',{})).body.status,'cancelled');
 await wait(500);
 assert.equal((await call('/api/projects/'+cancelledJob.body.id)).body.status,'cancelled');
 const imported=await fetch(base+'/api/projects?filename=new.wav',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:wav});
 const importedProject=await imported.json();assert.equal(imported.status,202);assert.equal(importedProject.demucsRequest.model,'htdemucs_ft');
 assert.equal(importedProject.analyses.length,1);
 const importDone=await until(async()=>(await call('/api/projects/'+importedProject.id)).body,p=>['ready','error'].includes(p.status));
 assert.equal(importDone.status,'ready',logs);assert.equal(importDone.result.separation.provider,'demucs-lab');
});
