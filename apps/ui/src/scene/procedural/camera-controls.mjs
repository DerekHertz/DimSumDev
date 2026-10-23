import {dragOrbit,dragPan,keyPan,pinchZoom,wheelZoom} from './camera.mjs';

export function bindCameraControls({canvas,host,store,view,enabled,doc=document,win=window}){
  const pointers=new Map(),listeners=[];
  let drag=null,pinch=null;
  const listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);listeners.push(()=>target.removeEventListener(type,fn,options));};
  const clear=()=>{
    const ids=[...pointers.keys()];pointers.clear();drag=null;pinch=null;
    for(const id of ids)canvas.releasePointerCapture?.(id);
  };
  const spread=()=>{const [a,b]=[...pointers.values()];return Math.hypot(a.x-b.x,a.y-b.y);};
  const down=e=>{
    if(!enabled()){clear();return;}
    if(e.button!==0&&e.button!==2)return;
    const point={x:e.clientX,y:e.clientY,pan:e.shiftKey||e.button===2};
    pointers.set(e.pointerId,point);
    if(pointers.size===2){drag=null;pinch={dist:spread(),zoom:store.getZoom()};}
    else if(pointers.size===1)drag=point;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const move=e=>{
    if(!enabled()){clear();return;}
    if(!pointers.has(e.pointerId))return;
    const previous=pointers.get(e.pointerId),point={...previous,x:e.clientX,y:e.clientY};pointers.set(e.pointerId,point);
    if(pinch&&pointers.size===2){store.setZoom(pinchZoom(pinch.zoom,pinch.dist,spread()));return;}
    if(!drag)return;
    const delta={dx:point.x-drag.x,dy:point.y-drag.y};
    if(drag.pan)store.setTarget(dragPan(store.getTarget(),delta,view()));
    else store.setOrbit(dragOrbit(store.getOrbit(),delta));
    drag=point;
  };
  const up=e=>{
    pointers.delete(e.pointerId);canvas.releasePointerCapture?.(e.pointerId);
    if(pointers.size<2)pinch=null;
    drag=pointers.size===1?[...pointers.values()][0]:null;
  };
  const key=e=>{
    if(!enabled()||e.metaKey||e.ctrlKey||e.altKey||e.target.closest('input,textarea,select,button,a,[contenteditable],[role="dialog"]'))return;
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','_'].includes(e.key))return;
    e.preventDefault();
    if(e.key.startsWith('Arrow')){
      if(e.shiftKey)store.setTarget(keyPan(store.getTarget(),e.key,view()));
      else store.setOrbit(dragOrbit(store.getOrbit(),{dx:e.key==='ArrowLeft'?32:e.key==='ArrowRight'?-32:0,dy:e.key==='ArrowUp'?-32:e.key==='ArrowDown'?32:0}));
    }else store.stepZoom(e.key);
  };
  listen(canvas,'pointerdown',down);listen(canvas,'pointermove',move);listen(canvas,'pointerup',up);
  listen(canvas,'pointercancel',clear);listen(canvas,'lostpointercapture',e=>{if(pointers.has(e.pointerId))clear();});
  listen(canvas,'wheel',e=>{if(!enabled())return;e.preventDefault();store.setZoom(wheelZoom(store.getZoom(),e.deltaY));},{passive:false});
  listen(canvas,'contextmenu',e=>{if(enabled())e.preventDefault();});listen(host,'keydown',key);
  listen(win,'blur',clear);listen(doc,'focusin',clear);listen(doc,'visibilitychange',()=>{if(doc.hidden)clear();});
  return()=>{clear();listeners.forEach(off=>off());};
}
