import React, {useState} from 'react';
import {apiPath} from './paths.mjs';

export default function DemucsSeparation({project,busy,onCreated}) {
  const [opened,setOpened]=useState(false), [passage,setPassage]=useState(false);
  const [start,setStart]=useState(0), [end,setEnd]=useState(30);
  const [running,setRunning]=useState(false), [error,setError]=useState('');
  async function submit(event) {
    event.preventDefault();setRunning(true);setError('');
    try {
      const response=await fetch(apiPath(`/api/projects/${project.id}/demucs`), {
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({range:passage?[Number(start),Number(end)]:null}),
      });
      const value=await response.json();
      if(!response.ok)throw new Error(value.error);
      await onCreated(value);setOpened(false);
    } catch(error) {setError(error.message)} finally {setRunning(false)}
  }
  return <section className="sam-separation" aria-label="Demucs instrument analysis">
    <div className="sam-toolbar">
      <button disabled={busy||running} aria-expanded={opened} onClick={()=>setOpened(v=>!v)}>Separate stems & analyse instruments</button>
      {project.demucsRequest && <small>Demucs → instrument stems → notes and patches · {project.demucsRequest.range ? `${project.demucsRequest.range[0]}–${project.demucsRequest.range[1]} s` : 'Full recording'}</small>}
    </div>
    {opened && <form className="sam-form" onSubmit={submit}>
      <p>Uses the Sound editor’s Demucs model, discovers drum sounds and up to 12 synth instruments within “other”, then fits each instrument. Vocals are excluded. Saves a separate analysis.</p>
      <div className="sam-options">
        <label><input type="checkbox" checked={passage} onChange={e=>setPassage(e.target.checked)}/> Test a passage</label>
        {passage && <>
          <label>From (s) <input aria-label="Demucs passage start" type="number" min="0" step="0.1" required value={start} onChange={e=>setStart(e.target.value)}/></label>
          <label>To (s) <input aria-label="Demucs passage end" type="number" min={Number(start)+.3} step="0.1" required value={end} onChange={e=>setEnd(e.target.value)}/></label>
        </>}
      </div>
      <button className="primary" disabled={busy||running}>{running?'Starting…':'Start instrument analysis'}</button>
      {error && <p role="alert">{error}</p>}
    </form>}
  </section>;
}
