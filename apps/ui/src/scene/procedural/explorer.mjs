/** Ground-level exploration with mouse capture or drag-to-look fallback: the THREE and DOM adapter over the pure walk core. */
import { walk, startWalk, isDenPositionBlocked, isWalkBlocked } from './walk.mjs';
import { REVIEW_OBSTACLES } from '../../review/site-plan.mjs';
export { isDenPositionBlocked };
export function createDenExplorer(THREE,{canvas,orbitControls,den,onModeChange=()=>{},onHint=()=>{},onCursorChange=()=>{}}) {
  const camera=new THREE.PerspectiveCamera(66,1,0.045,160);
  const keys=new Set(),listeners=[];
  let active=false,state=startWalk(den.walkStart),look={dx:0,dy:0},drag=null,wasLocked=false,freeCursorRequested=false;
  function listen(target,event,callback,options){
    target.addEventListener(event,callback,options);
    listeners.push(()=>target.removeEventListener(event,callback,options));
  }
  function place(){camera.position.set(state.x,state.y,state.z);camera.rotation.set(state.pitch,state.yaw,0,'YXZ');}
  function fallback(){if(active){onCursorChange(true);onHint('WASD / arrows to walk · drag to look · Shift to go faster · Esc to leave');}}
  function capture(){
    freeCursorRequested=false;keys.clear();look={dx:0,dy:0};
    if(!active||!canvas.requestPointerLock){fallback();return;}
    try{
      const pending=canvas.requestPointerLock();
      if(pending?.catch)pending.catch(fallback);
    }catch{fallback();}
  }
  // Release the pointer lock without leaving the den (Tab does this too), so cards and panels can be clicked.
  function freeCursor(){
    if(!active||document.pointerLockElement!==canvas)return;
    freeCursorRequested=true;keys.clear();drag=null;look={dx:0,dy:0};document.exitPointerLock();
  }
  function enter(){
    if(active)return;
    active=true;freeCursorRequested=false;keys.clear();look={dx:0,dy:0};state=startWalk(den.walkStart);
    place();orbitControls.enabled=false;
    onModeChange(true);fallback();capture();
  }
  function exit(){
    if(!active)return;
    active=false;freeCursorRequested=false;keys.clear();drag=null;orbitControls.enabled=true;onCursorChange(false);onModeChange(false);
    if(document.pointerLockElement===canvas)document.exitPointerLock();
    wasLocked=false;
  }
  listen(document,'pointerlockchange',()=>{
    const locked=document.pointerLockElement===canvas;
    if(active&&locked){onCursorChange(false);onHint('WASD / arrows to walk · mouse to look · Shift to go faster · Tab frees the cursor · Esc to leave');}
    // team-and-den-ux/04 (spec 1.6): a lock the browser released (its own Escape) frees the cursor; the next Escape leaves.
    if(wasLocked&&!locked&&active){onCursorChange(true);onHint('Cursor free · click cards · Look around to resume · Esc again to leave');}
    wasLocked=locked;
  });
  listen(document,'pointerlockerror',fallback);
  listen(document,'keydown',e=>{
    if(!active)return;
    if(e.code==='Escape'){
      e.preventDefault();
      if(document.pointerLockElement===canvas)freeCursor();else exit();
      return;
    }
    if(e.code==='Tab'&&document.pointerLockElement===canvas){
      e.preventDefault();freeCursor();return;
    }
    if(e.target.closest?.('input,select,textarea,button,a,[contenteditable],[role="dialog"],.transcript-panel,.approval-panel'))return;
    if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight'].includes(e.code)){
      e.preventDefault();keys.add(e.code);
    }
  });
  listen(document,'keyup',e=>keys.delete(e.code));
  listen(document,'focusin',()=>{keys.clear();drag=null;});
  listen(window,'blur',()=>{keys.clear();drag=null;});
  listen(document,'visibilitychange',()=>{if(document.hidden){keys.clear();drag=null;}});
  function turn(dx,dy){look.dx+=dx;look.dy+=dy;}
  listen(document,'mousemove',e=>{if(active&&document.pointerLockElement===canvas)turn(e.movementX,e.movementY);});
  listen(canvas,'pointerdown',e=>{
    if(!active||freeCursorRequested||document.pointerLockElement===canvas||e.button!==0)return;
    drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);
  });
  listen(canvas,'pointermove',e=>{
    if(!active||!drag||drag.id!==e.pointerId)return;
    turn(e.clientX-drag.x,e.clientY-drag.y);drag.x=e.clientX;drag.y=e.clientY;
  });
  const endDrag=e=>{if(drag?.id===e.pointerId)drag=null;};
  listen(canvas,'pointerup',endDrag);listen(canvas,'pointercancel',endDrag);listen(canvas,'lostpointercapture',endDrag);
  listen(canvas,'dblclick',()=>{if(active)capture();});
  // den.obstacles holds the mounted zones (pond, repair bench, archive); the site plan adds the village's buildings and props.
  function world(){return den.walkWorld ? {...den.walkWorld,avoid:den.walkAvoid?.()||[]} : {obstacles:[...den.obstacles,...REVIEW_OBSTACLES],avoid:[]};}
  const blocked=(x,z)=>isWalkBlocked(x,z,world());
  function update(delta){
    if(!active||freeCursorRequested)return;
    const forward=Number(keys.has('KeyW')||keys.has('ArrowUp'))-Number(keys.has('KeyS')||keys.has('ArrowDown'));
    const strafe=Number(keys.has('KeyD')||keys.has('ArrowRight'))-Number(keys.has('KeyA')||keys.has('ArrowLeft'));
    const input={forward,strafe,sprint:keys.has('ShiftLeft')||keys.has('ShiftRight'),look,
      reducedMotion:window.matchMedia('(prefers-reduced-motion: reduce)').matches};
    state=walk(state,input,delta,world());
    look={dx:0,dy:0};
    place();
  }
  function bindButton(element,key){
    listen(element,'pointerdown',e=>{
      if(!active)return;e.preventDefault();e.stopPropagation();element.setPointerCapture(e.pointerId);keys.add(key);
    });
    const release=e=>{keys.delete(key);e.stopPropagation();};
    listen(element,'pointerup',release);listen(element,'pointercancel',release);listen(element,'lostpointercapture',release);
  }
  function resize(aspect){camera.aspect=aspect;camera.updateProjectionMatrix();}
  function dispose(){exit();for(const remove of listeners)remove();}
  return {camera,enter,exit,capture,freeCursor,update,resize,bindButton,dispose,blocked,get active(){return active;}};
}
