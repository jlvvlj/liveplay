import React from 'react';
export default function AnalysisHistory({project,projects,busy,onOpen}) {
 const origin=project.analysisSourceProjectId || project.samSourceProjectId || project.id;
 const versions=projects.filter(p=>p.id===origin || p.analysisSourceProjectId===origin || p.samSourceProjectId===origin);
 if(versions.length<2)return null;
 return <div className="sam-toolbar"><label>Analysis <select aria-label="Instrument analysis" value={project.id} disabled={busy} onChange={e=>onOpen(e.target.value)}>
 {versions.map(p=><option key={p.id} value={p.id}>{p.demucsRequest?'Demucs instruments':p.samRequest?'SAM Audio (archived)':'Earlier analysis'} · {new Date(p.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} · {p.status}</option>)}
 </select></label></div>;
}
