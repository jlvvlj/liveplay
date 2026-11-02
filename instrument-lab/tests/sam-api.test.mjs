import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateSamRequest} from '../server/sam.mjs';
import {encodeWav,DEFAULT_PATCH} from '../engine/synth.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,accept){for(let i=0;i<300;i++){const v=await fn();if(accept(v))return v;await wait(30)}throw Error('Timed out')}
const requestBody={targets:[{name:'Bass',description:'Low electronic bass',engine:'melodic'},{name:'Lead',description:'Bright synth melody',engine:'melodic'}],spanMode:'predict',candidates:4,range:[0,1]};
test('SAM request rejects unsafe or ambiguous jobs before submission',()=>{
 for(const v of [{}, {...requestBody,targets:[]}, {...requestBody,targets:[requestBody.targets[0],requestBody.targets[0]]},{...requestBody,range:[3,1]},{...requestBody,candidates:100},{...requestBody,spanMode:'x'}]) assert.throws(()=>validateSamRequest(v));
 assert.equal(validateSamRequest(requestBody).targets.length,2);
});
test('SAM API creates a separate analysis, keeps reference audio on edits, merges stems, and cancels remote work',{timeout:25000},async(t)=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sam-api-')), data=path.join(temp,'data'), id='11111111-1111-4111-8111-111111111111';
 const folder=path.join(data,id);await fs.mkdir(folder,{recursive:true});
 const wav=Buffer.from(encodeWav(Float32Array.from({length:22050},(_,i)=>Math.sin(i*.03)*.1),22050));
 await fs.writeFile(path.join(folder,'upload.wav'),wav);
 const original={id,title:'Existing recording',uploadFile:'upload.wav',engine:'melodic',status:'ready',revision:7,createdAt:1,documentFile:'existing.json'};
 await fs.writeFile(path.join(folder,'project.json'),JSON.stringify(original));
 const result={engine:'melodic',duration:1,parts:[],analysis:{notes:0,warnings:[]}};await fs.writeFile(path.join(folder,'existing.json'),JSON.stringify(result));
 const script=path.join(temp,'fake.mjs');
 await fs.writeFile(script,`#!${process.execPath}
import fs from 'node:fs/promises';import path from 'node:path';
const a=process.argv.slice(2);const folder=a[a.indexOf('--output')+1];
if(a.includes('--check')){console.log(JSON.stringify({stage:'Connected',account:'test'}));process.exit(0)}
if(a.includes('--cancel')){await fs.writeFile(${JSON.stringify(path.join(temp,'cancelled'))},'yes');process.exit(0)}
if(a[0].endsWith('client.py')){await new Promise(r=>setTimeout(r,450));console.log(JSON.stringify({stage:'Downloaded',progress:.7,remoteJob:{id:'test-job',url:'https://huggingface.co/jobs/test/test-job',status:'COMPLETED'}}));process.exit(0)}
if(a.includes('-i')){await fs.copyFile(a[a.indexOf('-i')+1],a.at(-1));process.exit(0)}
if(a[0].endsWith('reextract.py'))throw Error('Must never re-extract an immutable SAM stem');
const config=JSON.parse(await fs.readFile(a[a.indexOf('--request')+1]));
const parts=config.targets.map((t,i)=>({id:'instrument-'+(i+1),name:t.name,engine:t.engine,patch:${JSON.stringify(DEFAULT_PATCH)},notes:[{pitch:48+i*12,start:.1,end:.5,velocity:90}],referenceFile:'instrument-'+(i+1)+'-reference.wav',referenceWaveform:[.1,.2],separation:{provider:'sam-audio',sourceId:'instrument-'+(i+1)}}));
for(const p of parts)await fs.copyFile(a[a.indexOf('--input')+1],path.join(folder,p.referenceFile));
await fs.writeFile(path.join(folder,'result.json'),JSON.stringify({engine:'mixed',duration:1,parts,analysis:{notes:2,warnings:[]},separation:{provider:'sam-audio'}}));
`,{mode:0o755});
 const server=spawn(process.execPath,[path.join(root,'server/index.mjs')],{env:{...process.env,NODE_ENV:'production',INSTRUMENT_LAB_PORT:'0',INSTRUMENT_LAB_DATA:data,INSTRUMENT_LAB_HF_PYTHON:script,INSTRUMENT_LAB_PYTHON:script,FFMPEG_PATH:script},stdio:['ignore','pipe','pipe']});
 let logs='';server.stdout.on('data',c=>logs+=c);server.stderr.on('data',c=>logs+=c);
 t.after(async()=>{if(server.exitCode===null){const end=once(server,'exit');server.kill('SIGTERM');await end}await fs.rm(temp,{recursive:true,force:true})});
 const base=await until(()=>logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0],Boolean);
 const call=async(url,body,method='POST')=>{const r=await fetch(base+url,body===undefined?undefined:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 assert.equal((await call('/api/sam/status')).body.available,true);
 const invalid=await call('/api/projects/'+id+'/sam',{});assert.equal(invalid.status,400);
 const job=await call('/api/projects/'+id+'/sam',requestBody);assert.equal(job.status,202);assert.notEqual(job.body.id,id);
 assert.equal((await call('/api/projects/'+id+'/sam',requestBody)).status,409);
 const endpoint='/api/projects/'+job.body.id;
 let done=await until(async()=>(await call(endpoint)).body,p=>p.status==='ready'||p.status==='error');assert.equal(done.status,'ready',logs+JSON.stringify(done));
 assert.equal(done.result.parts.length,2);assert.equal(done.analyses.length,1,'No legacy drum discovery joins SAM runs');
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,'project.json'))),original);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,'existing.json'))),result);
 const ref=done.result.parts[0].referenceFile, before=await fs.readFile(path.join(data,done.id,ref));
 const edit=await call(endpoint+'/edit',{revision:0,partId:'instrument-1',notes:[{pitch:50,start:.2,end:.6,velocity:80}]},'PUT');assert.equal(edit.status,200);
 assert.equal(edit.body.result.parts[0].referenceFile,ref);assert.deepEqual(await fs.readFile(path.join(data,done.id,ref)),before);
 const merged=await call(endpoint+'/edit',{revision:1,partId:'instrument-1',assignment:{action:'merge',targetId:'instrument-2'}},'PUT');assert.equal(merged.status,200);assert.equal(merged.body.result.parts.length,1);assert.notEqual(merged.body.result.parts[0].referenceFile,ref);
 assert.deepEqual(await fs.readFile(path.join(data,done.id,ref)),before);
 const cancelJob=await call('/api/projects/'+id+'/sam',requestBody);
 const cancelled=await call('/api/projects/'+cancelJob.body.id+'/cancel',{});assert.equal(cancelled.body.status,'cancelled');assert.equal(await fs.readFile(path.join(temp,'cancelled'),'utf8'),'yes');
});
