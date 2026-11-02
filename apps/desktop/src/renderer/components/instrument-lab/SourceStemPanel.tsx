import {useEffect,useState} from 'react';
import {Song} from '../../types/song';
import {Lesson} from '../../types/lesson';
import {SourceSoundEditor} from './SourceSoundEditor';
type Project = {id:string;sourceSongIds?:string[];analysisSourceProjectId?:string;samSourceProjectId?:string;parentProjectId?:string};
export function SourceStemPanel({project,projects,onExit,onAudition,onStartLesson}:{project:Project;projects:Project[];onExit:()=>void;onAudition:()=>void;onStartLesson:(lesson:Lesson)=>void}) {
 let source:Project|undefined=project;
 const visited=new Set<string>();
 while(source && !source.sourceSongIds?.length && !visited.has(source.id)) {
  visited.add(source.id);
  const parent=source.analysisSourceProjectId || source.samSourceProjectId || source.parentProjectId;
  source=projects.find(p=>p.id===parent);
 }
 const songId=source?.sourceSongIds?.[0];
 const [song,setSong]=useState<Song|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let live=true;setSong(null);setError('');
  if(songId)fetch(`/api/songs/${encodeURIComponent(songId)}`).then(async r=>{const v=await r.json();if(!r.ok)throw new Error(v.error || 'Could not load original stems');return v;}).then(v=>{if(live)setSong(v);}).catch(e=>{if(live)setError(e.message);});
  return()=>{live=false;};
 },[songId,retry]);
 if(!songId)return <section className="source-editor-status">Initial song stems are available for recordings imported through Songs.</section>;
 if(error)return <section className="source-editor-status" role="alert">{error} <button onClick={()=>setRetry(n=>n+1)}>Retry loading stems</button></section>;
 if(!song || song.id!==songId)return <section className="source-editor-status" role="status">Loading initial song stems…</section>;
 if(!song.stems)return <section className="source-editor-status">The original song’s stems have not finished separating. <button onClick={()=>setRetry(n=>n+1)}>Refresh stems</button></section>;
 return <SourceSoundEditor key={song.id} song={song} onExit={onExit} onAudition={onAudition} onStartLesson={onStartLesson}/>;
}
