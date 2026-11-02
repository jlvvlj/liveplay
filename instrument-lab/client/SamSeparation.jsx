import React, { useEffect, useState } from 'react';
import { apiPath } from './paths.mjs';

function suggestions(project) {
  if (project.samRequest) return project.samRequest.targets;
  return (project.result?.parts || []).slice(0,24).map((p,i)=> {
    const pitches=p.notes.map(n=>n.pitch), median=pitches.sort((a,b)=>a-b)[Math.floor(pitches.length/2)] || 60;
    const register=median<48?'low bass':median>72?'high':'mid-register';
    return {name:p.name, engine:p.engine==='drum'?'drum':'melodic', description:
      p.engine==='drum' ? `Electronic percussion sound ${i+1}; describe its timbre` :
      `${register} ${p.patch.family === 'fm' ? 'FM' : p.patch.family || ''} synthesizer, ${p.patch.attack>.15?'slow sustained':'short articulated'} notes`};
  });
}
export default function SamSeparation({project,projects,onOpen,onCreated,busy}) {
  const [opened,setOpened]=useState(false), [targets,setTargets]=useState([]), [running,setRunning]=useState(false);
  const [mode,setMode]=useState('predict'), [candidates,setCandidates]=useState(4), [passage,setPassage]=useState(false);
  const [start,setStart]=useState(0),[end,setEnd]=useState(30),[error,setError]=useState(''),[connection,setConnection]=useState(null);
  const origin=project.analysisSourceProjectId || project.samSourceProjectId || project.id;
  const versions=projects.filter(p=>p.id===origin || p.samSourceProjectId===origin || p.analysisSourceProjectId===origin);
  useEffect(()=>{
    setOpened(false);setError('');setTargets(suggestions(project));
    setPassage(!!project.samRequest?.range);setStart(project.samRequest?.range?.[0] || 0);
    setEnd(project.samRequest?.range?.[1] || Math.min(30,project.result?.duration || 30));
  },[project.id]);
  useEffect(()=>{
    if(!opened) return;
    let live=true;
    fetch(apiPath('/api/sam/status')).then(r=>r.json()).then(v=>{if(live)setConnection(v)}).catch(()=>{if(live)setConnection({available:false})});
    return ()=>{live=false};
  },[opened]);
  function change(index,field,value){setTargets(items=>items.map((t,i)=>i===index?{...t,[field]:value}:t))}
  async function submit(e){
    e.preventDefault();setRunning(true);setError('');
    try{
      const response=await fetch(apiPath(`/api/projects/${project.id}/sam`),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targets,spanMode:mode,candidates,range:passage?[Number(start),Number(end)]:null})});
      const value=await response.json();if(!response.ok)throw new Error(value.error);
      await onCreated(value);setOpened(false);
    }catch(e){setError(e.message)}finally{setRunning(false)}
  }
  return <section className="sam-separation" aria-label="SAM Audio separation">
    <div className="sam-toolbar">
      <button onClick={()=>setOpened(v=>!v)} aria-expanded={opened} disabled={busy || running}>Separate with SAM Audio</button>
      {versions.length>1 && <label>Analysis <select aria-label="Instrument analysis" value={project.id} onChange={e=>onOpen(e.target.value)} disabled={busy||running}>
        {versions.map(p=><option key={p.id} value={p.id}>{p.samRequest || p.demucsRequest?`${p.demucsRequest ? 'Demucs instruments' : 'SAM Audio'} · ${new Date(p.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} · ${p.status}`:'Earlier analysis'}</option>)}
      </select></label>}
      {project.remoteJob?.url && <a href={project.remoteJob.url} target="_blank" rel="noreferrer">Hugging Face job ↗</a>}
      {project.samRequest && <small>SAM Audio · {project.samRequest.range?`Passage ${project.samRequest.range[0]}–${project.samRequest.range[1]} s`:'Full recording'} · review extraction</small>}
    </div>
    {opened && <form onSubmit={submit} className="sam-form">
      <p>Describe each sound to extract from the original recording. Each description creates one stem and one playable instrument. Suggestions come from the earlier analysis.</p>
      <div className="sam-targets">
      {targets.map((t,i)=><div className="sam-target" key={i}>
        <input type="text" aria-label={`Instrument ${i+1} name`} required maxLength={80} value={t.name} onChange={e=>change(i,'name',e.target.value)}/>
        <input type="text" aria-label={`Instrument ${i+1} description`} placeholder="e.g. deep pulsing bass synthesizer" required minLength={3} maxLength={500} value={t.description} onChange={e=>change(i,'description',e.target.value)}/>
        <select aria-label={`Instrument ${i+1} type`} value={t.engine} onChange={e=>change(i,'engine',e.target.value)}><option value="melodic">Synth</option><option value="drum">Drum</option></select>
        <button type="button" aria-label={`Remove target ${i+1}`} onClick={()=>setTargets(v=>v.filter((_,j)=>j!==i))}>×</button>
      </div>)}
      </div>
      <button type="button" disabled={targets.length>=24} onClick={()=>setTargets(v=>[...v,{name:`Instrument ${v.length+1}`,description:'',engine:'melodic'}])}>Add sound description</button>
      <div className="sam-options">
        <label>Timing prompts <select value={mode} onChange={e=>setMode(e.target.value)}><option value="predict">Automatic</option><option value="none">Text only</option></select></label>
        <label>Candidates <select value={candidates} onChange={e=>setCandidates(Number(e.target.value))}><option value={4}>4 · compare extractions</option><option value={1}>1 · faster</option></select></label>
        <label><input type="checkbox" checked={passage} onChange={e=>setPassage(e.target.checked)}/> Test a passage</label>
        {passage && <><label>From (s) <input type="number" min="0" step="0.1" required value={start} onChange={e=>setStart(e.target.value)}/></label><label>To (s) <input type="number" min={Number(start)+.1} step="0.1" required value={end} onChange={e=>setEnd(e.target.value)}/></label></>}
      </div>
      <div className="sam-run"><button className="primary" disabled={running||busy||!targets.length||connection?.available===false}>{running?'Starting…':'Start separation'}</button>
      <small>Private audio upload · paid Hugging Face GPU job · 30-minute limit · saves a separate analysis</small></div>
      {connection?.available===false && <p role="alert">{connection.message || 'Cannot connect to Hugging Face. Check the analysis server connection.'}</p>}
      {error && <p role="alert">{error}</p>}
    </form>}
  </section>;
}
