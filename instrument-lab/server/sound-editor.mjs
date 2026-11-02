// Independent Sound editor documents for Lab instrument stems. Never writes to
// the song Sound editor or to the Lab's notes, patches, or reference audio.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import express from 'express';
const exec = promisify(execFile);
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const safePart = id => /^instrument-\d+$/.test(id);
const audioName = file => /^(?:[a-f0-9-]{36}-)?(?:source|reconstruction|instrument-\d+-(?:reference|synth|sample))\.wav$/.test(file);
const round = n => Math.round(n*10000)/10000;

export function detectedSounds(part,duration) {
  const sounds=[], events=[], byPitch=new Map();
  for(const note of part.notes) {
    const pitch=part.engine==='drum'?36:Math.round(note.pitch);
    let sound=byPitch.get(pitch);
    if(!sound) {
      sound={id:sounds.length,start:note.start,end:Math.min(duration,Math.max(note.end,note.start+.03)),pitch,centroidHz:0,clip:'',label:part.engine==='drum'?part.name:`${['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][pitch%12]}${Math.floor(pitch/12)-1}`};
      byPitch.set(pitch,sound);sounds.push(sound);
    }
    events.push({time:note.start,sound:sound.id,velocity:Math.max(1,Math.min(127,Math.round((note.velocity??.8)*((note.velocity??.8)<=1?127:1)))),duration:note.end-note.start,pitch:note.pitch});
  }
  return {sounds,events};
}
export function validateEdits(body,duration) {
  if(!Array.isArray(body?.sounds)||!Array.isArray(body?.events)||body.sounds.length>128||body.events.length>100000)throw fail('Invalid sound edits');
  const ids=new Set();
  const sounds=body.sounds.map(s=>{
    if(!Number.isInteger(s.id)||s.id<0||s.id>10000||ids.has(s.id)||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end>duration+.001||s.end-s.start<.029)throw fail('Invalid sound region');
    ids.add(s.id);
    return {id:s.id,start:round(s.start),end:round(Math.min(duration,s.end)),centroidHz:0,...(Number.isFinite(s.pitch)?{pitch:Math.max(0,Math.min(127,s.pitch))}:{}),...(typeof s.label==='string'?{label:s.label.slice(0,80)}:{})};
  });
  const events=body.events.map(e=>{
    if(!ids.has(e.sound)||!Number.isFinite(e.time)||e.time<0||e.time>=duration||!Number.isFinite(e.velocity)||e.velocity<1||e.velocity>127)throw fail('Invalid sound event');
    const sound=sounds.find(s=>s.id===e.sound);
    return {time:round(e.time),sound:e.sound,velocity:Math.round(e.velocity),duration:round(Math.min(duration-e.time,sound.end-sound.start)),...(Number.isFinite(e.pitch)?{pitch:Math.max(0,Math.min(127,e.pitch))}:{})};
  }).sort((a,b)=>a.time-b.time);
  return {sounds,events};
}
export function registerSoundEditor(app,{dir,read,write,exclusive,root,python}) {
  const base='/api/projects/:id/sound-editor/:part';
  const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
  const json=express.json({limit:'4mb'});
  async function context(req) {
    const {id,part:partId}=req.params;
    if(!safePart(partId))throw fail('Instrument not found',404);
    const project=await read(id);
    if(project.status!=='ready')throw fail('Wait for instrument analysis to finish',409);
    const result=await read(id,project.documentFile||'edited.json');
    const part=result.parts.find(p=>p.id===partId);
    if(!part||!audioName(part.referenceFile))throw fail('Instrument stem not found',404);
    return {id,project,result,part,folder:dir(id),doc:`sound-editor-${partId}.json`,stem:path.join(dir(id),part.referenceFile)};
  }
  async function initial(c,rev=1) {
    const value={stem:c.part.id,bpm:c.result.bpm||120,duration:c.result.duration,...detectedSounds(c.part,c.result.duration),referenceFile:c.part.referenceFile,rev};
    await write(c.id,c.doc,value);return value;
  }
  async function load(c) {
    let value;
    try {value=await read(c.id,c.doc);}catch(e){if(e.code!=='ENOENT')throw e;}
    // A merged/replaced reference gets a fresh document. Existing edited clips
    // remain immutable and can still be played by an already-open lesson.
    return value?.referenceFile===c.part.referenceFile?value:initial(c,(value?.rev||0)+1);
  }
  function checkRevision(body,value) {
    if(body.rev!==value.rev||body.referenceFile!==value.referenceFile)throw fail('The stem or audio edits changed. Reload this analysis before saving.',409);
  }
  async function slice(c,value) {
    const generation=randomUUID();
    const output=path.join(c.folder,'sound-editor',c.part.id,generation);
    await fs.mkdir(output,{recursive:true});
    try {
      for(const sound of value.sounds) {
        const length=sound.end-sound.start,fade=length*.75;
        await exec(process.env.FFMPEG_PATH||'/opt/homebrew/bin/ffmpeg',['-v','error','-y','-ss',String(sound.start),'-t',String(length),'-i',c.stem,'-af',`afade=t=out:st=${fade.toFixed(4)}:d=${(length-fade).toFixed(4)},loudnorm=I=-16:TP=-1.5`,'-c:a','pcm_s16le',path.join(output,`sound-${sound.id}.wav`)],{timeout:60000});
        sound.clip=`../api/instruments/projects/${c.id}/sound-editor/${c.part.id}/clips/${generation}/sound-${sound.id}.wav`;
      }
      return value;
    }catch(e){await fs.rm(output,{recursive:true,force:true});throw e;}
  }
  app.post(base,json,route(async(req,res)=>exclusive(req.params.id,async()=>res.json(await load(await context(req))))));
  app.put(base,json,route(async(req,res)=>exclusive(req.params.id,async()=>{
    const c=await context(req),old=await load(c);checkRevision(req.body,old);
    const value={...old,...validateEdits(req.body,old.duration),rev:old.rev+1};
    await slice(c,value);await write(c.id,c.doc,value);res.json(value);
  })));
  app.delete(base,json,route(async(req,res)=>exclusive(req.params.id,async()=>{
    const c=await context(req),old=await load(c);checkRevision(req.body,old);
    res.json(await initial(c,old.rev+1));
  })));
  app.post(`${base}/match`,json,route(async(req,res)=>exclusive(req.params.id,async()=>{
    const c=await context(req),data=validateEdits({sounds:req.body.sounds,events:[]},c.result.duration);
    if(!data.sounds.length)return res.json({events:[]});
    const input=path.join(c.folder,`.sound-match-${randomUUID()}.json`);
    await fs.writeFile(input,JSON.stringify(data.sounds));
    try {
      const {stdout}=await exec(python,[path.join(root,'analysis/match_stem_sounds.py'),'--input',c.stem,'--sounds',input,'--sensitivity','1.65'],{timeout:600000,maxBuffer:32*1024*1024,env:{...process.env,NUMBA_CACHE_DIR:path.join(c.folder,'.numba-cache')}});
      const result=JSON.parse(stdout.trim().split('\n').at(-1));
      if(result.error)throw fail(result.error);
      res.json(validateEdits({sounds:data.sounds,events:result.events},c.result.duration));
    }finally{await fs.rm(input,{force:true});}
  })));
  app.post(`${base}/lesson`,route(async(req,res)=>exclusive(req.params.id,async()=>{
    const c=await context(req),value=await load(c);
    if(!value.events.length)throw fail('Add sound events before starting a lesson');
    if(value.sounds.some(s=>!s.clip)){await slice(c,value);await write(c.id,c.doc,value);}
    // Accompaniment is the other retained instrument stems, without the practiced stem.
    const others=c.result.parts.filter(p=>p.id!==c.part.id&&audioName(p.referenceFile));
    let backing;
    if(others.length) {
      const generation=randomUUID(),out=path.join(c.folder,'sound-editor',c.part.id,generation);
      await fs.mkdir(out,{recursive:true});
      await exec(process.env.FFMPEG_PATH||'/opt/homebrew/bin/ffmpeg',['-v','error','-y',...others.flatMap(p=>['-i',path.join(c.folder,p.referenceFile)]),'-filter_complex',`amix=inputs=${others.length}:normalize=0`,'-c:a','pcm_s16le',path.join(out,'backing.wav')],{timeout:120000});
      backing=`../api/instruments/projects/${c.id}/sound-editor/${c.part.id}/clips/${generation}/backing.wav`;
    }
    const samples={},laneLabels={},pitches=new Map(value.sounds.map(s=>[s.id,s.pitch]));
    for(const s of value.sounds){samples[36+s.id]=s.clip;laneLabels[36+s.id]=s.label||`Sound ${s.id+1}`;}
    res.json({id:`lab-audio-${c.id}-${c.part.id}-${value.rev}`,title:`${c.project.title} — ${c.part.name}`,instrument:'pads',bpm:value.bpm,timeSignature:{numerator:4,denominator:4},samples,laneLabels,backingTrack:backing,steps:value.events.map(e=>({tick:Math.round(e.time*value.bpm*480/60),note:36+e.sound,dur:120,velocity:e.velocity,lane:e.sound,...(Number.isFinite(e.pitch)&&Number.isFinite(pitches.get(e.sound))?{semitones:e.pitch-pitches.get(e.sound)}:{})})),metadata:{genre:'Song practice',tags:['instrument-lab','audio'],description:`${value.sounds.length} edited stem sounds`}});
  })));
  app.get(`${base}/clips/:generation/:file`,route(async(req,res)=>{
    dir(req.params.id);
    if(!safePart(req.params.part)||! /^[a-f0-9-]{36}$/.test(req.params.generation)||! /^(sound-\d+|backing)\.wav$/.test(req.params.file))throw fail('Clip not found',404);
    res.sendFile(path.join(dir(req.params.id),'sound-editor',req.params.part,req.params.generation,req.params.file));
  }));
}
