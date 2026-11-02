import React from 'react';
// Reads the immutable separated stem; shares the note timeline's seek/zoom window.
export default function StemWaveform({part,start,span,duration,head,seekProps}) {
  const values=part.referenceWaveform;
  if(!values?.length) return null;
  const bins=700, path=[];
  for(let i=0;i<bins;i++){
    const lo=Math.max(0,Math.floor((start+i*span/bins)/duration*values.length));
    const hi=Math.min(values.length,Math.max(lo+1,Math.ceil((start+(i+1)*span/bins)/duration*values.length)));
    let peak=0;for(let j=lo;j<hi;j++)peak=Math.max(peak,values[j]);
    const height=Math.min(1,peak)*29;
    path.push(`M${i} ${32-height}v${height*2}`);
  }
  return <div className="stem-waveform" data-timeline {...seekProps} aria-label={`Seek original stem ${part.name}`}>
    <span className="stem-waveform-label">Original stem</span>
    <svg viewBox={`0 0 ${bins} 64`} preserveAspectRatio="none" aria-hidden="true"><path d={path.join(' ')} fill="none" stroke="currentColor" strokeWidth=".8"/></svg>
    {head}
  </div>;
}
