import {useEffect,useRef} from 'react';
import * as THREE from 'three';
import {placeToolBubbles} from './tool-bubble-layout.mjs';

export function ToolBubbleLayer({bindings,stage,onInspect,picked,selected}){
 const nodes=useRef(new Map()),layer=useRef(null),latest=useRef({});latest.current={bindings,picked,selected};
 useEffect(()=>{
  let raf;
  const frame=()=>{
   const {camera}=stage,size=camera?.userData.viewport??stage.size;
   for(const el of nodes.current.values())el.style.visibility='hidden';
   if(camera&&size&&layer.current){
    camera.updateMatrixWorld();const rows=[];
    for(const [id,row]of latest.current.bindings){
     const anchor=stage.toolAnchors?.get(id);if(!anchor||!row.toolActivity)continue;
     const p=anchor.top.clone().project(camera),base=anchor.base.clone().project(camera);
     if(p.z<-1||p.z>1)continue;
     rows.push({id,x:(p.x+1)*size.width/2,y:(1-p.y)*size.height/2,height:Math.abs(p.y-base.y)*size.height/2,waiting:row.toolActivity.waiting,focused:id===latest.current.picked||row.ref===latest.current.selected});
    }
    const origin=layer.current.getBoundingClientRect();
    const blocked=[...document.querySelectorAll('[data-sheet],.den-float,.den-walk-pad,.den-entry,.zoom-switcher,.forest-legend,.meeting-label,.wave-ack')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden').map(el=>{const r=el.getBoundingClientRect();return {x:r.x-origin.x,y:r.y-origin.y,width:r.width,height:r.height};});
    // Model targets are protected too; the bubble sits above its own crown.
    for(const anchor of stage.toolAnchors?.values()??[]){const top=anchor.top.clone().project(camera),base=anchor.base.clone().project(camera);if(top.z>=-1&&top.z<=1)blocked.push({x:(top.x+1)*size.width/2-18,y:(1-top.y)*size.height/2,width:36,height:Math.max(24,Math.abs(top.y-base.y)*size.height/2)});}
    for(const p of placeToolBubbles(rows,{...size,blocked})){
     const el=nodes.current.get(p.id);if(!el)continue;
     el.style.left=`${p.x}px`;el.style.top=`${p.y}px`;el.style.visibility='visible';el.dataset.compact=String(p.compact);
    }
   }
   raf=requestAnimationFrame(frame);
  };raf=requestAnimationFrame(frame);return()=>cancelAnimationFrame(raf);
 },[stage]);
 return <div className="tool-bubble-layer" ref={layer}>{[...bindings].filter(([,row])=>row.toolActivity).map(([id,row])=><button type="button" key={id} ref={el=>el?nodes.current.set(id,el):nodes.current.delete(id)} className="tool-bubble" data-waiting={row.toolActivity.waiting} style={{visibility:'hidden'}} aria-label={`Inspect ${row.toolActivity.count} active tool ${row.toolActivity.count===1?'call':'calls'} for ${row.role}: ${row.toolActivity.text}`} onClick={()=>onInspect(row)}>
  <span className="tool-bubble-preview">{row.toolActivity.text}</span><span className="tool-bubble-compact" aria-hidden="true">⌘ {row.toolActivity.count}</span>
 </button>)}</div>;
}
