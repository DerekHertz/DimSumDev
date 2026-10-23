/**
 * Pure first-person walk core (den-v1/03): walk(state, input, dt, world) -> state.
 * No three, DOM or React in here; createDenExplorer in explorer.mjs is the thin adapter that feeds it keys, mouse
 * and the den's obstacles each frame (den-layout/04: the den's own plus the site plan's REVIEW_OBSTACLES).
 *
 *   state  {x, z, y, yaw, pitch, walkTime}   y is the eye height including the walking bob
 *   input  {forward, strafe, sprint, look:{dx,dy}, reducedMotion}   forward/strafe are -1, 0 or 1; look is mouse px
 *   world  {obstacles, avoid}   obstacles are the den's and the site plan's (circle, ellipse, rotated box); avoid is [{x,z,r}] for
 *                               things that move (roaming pandas)
 */
export const WALK = Object.freeze({
  eyeHeight: 1.65, speed: 5, sprintSpeed: 9, radius: 0.26, stepLength: 0.08,
  // The floor is the site plan's disc (review/layout.mjs: radius 28 at the origin, den-mvp/22); the walker's body stays inside it.
  floorRadius: 28,
  pitchMin: -1.20, pitchMax: 1.30, lookRate: 0.0025, bob: 0.012, bobRate: 9,
  // Just inside the garden gate, facing north up the village; the cub's nook (4.2, 20.6) is in front, so the walk begins at a panda.
  start: Object.freeze({x: 4.2, z: 23.4, yaw: 0, pitch: 0.14}),
});

export function isDenPositionBlocked(x,z,obstacles,radius=WALK.radius) {
  for(const o of obstacles){
    const dx=x-o.x,dz=z-o.z;
    if(o.type==='circle'&&dx*dx+dz*dz<(o.radius+radius)**2)return true;
    if(o.type==='ellipse'&&(dx/(o.rx+radius))**2+(dz/(o.rz+radius))**2<1)return true;
    if(o.type==='box'){
      const c=Math.cos(o.rotation||0),s=Math.sin(o.rotation||0);
      const lx=c*dx-s*dz,lz=s*dx+c*dz;
      if(Math.abs(lx)<o.halfX+radius&&Math.abs(lz)<o.halfZ+radius)return true;
    }
  }
  return false;
}

export function startWalk(start = WALK.start) {
  return {...start, y: (start.groundY??0)+(start.eyeHeight??WALK.eyeHeight), walkTime: 0};
}

export function isWalkBlocked(x,z,world) {
  const center=world.floorCenter||{x:0,z:0};
  if(Math.hypot(x-center.x,z-center.z)>(world.floorRadius??WALK.floorRadius)-WALK.radius)return true;
  if(world.navigation?.groundAt(x,z,world.groundY??0)===null)return true;
  if(isDenPositionBlocked(x,z,world.obstacles||[]))return true;
  for(const a of world.avoid||[])if(Math.hypot(x-a.x,z-a.z)<a.r)return true;
  return false;
}

export function walk(state,input,dt,world) {
  const look=input.look||{dx:0,dy:0};
  const yaw=state.yaw-look.dx*WALK.lookRate;
  const pitch=Math.max(WALK.pitchMin,Math.min(WALK.pitchMax,state.pitch-look.dy*WALK.lookRate));
  const forward=input.forward||0,strafe=input.strafe||0;
  const length=Math.hypot(forward,strafe);
  let {x,z,walkTime}=state;
  let groundY=state.groundY??0;
  const canMove=(nx,nz)=>{
    const nextGround=world.navigation?.groundAt(nx,nz,groundY)??(world.navigation?null:0);
    if(nextGround===null||isWalkBlocked(nx,nz,{...world,groundY:nextGround}))return false;
    groundY=nextGround;return true;
  };
  if(length){
    const speed=input.sprint?WALK.sprintSpeed:WALK.speed;
    const dx=(-Math.sin(yaw)*forward+Math.cos(yaw)*strafe)/length*speed*dt;
    const dz=(-Math.cos(yaw)*forward-Math.sin(yaw)*strafe)/length*speed*dt;
    // Sub-steps no longer than a stride keep a long frame from jumping a prop; each axis slides on its own.
    const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/WALK.stepLength));
    for(let i=0;i<steps;i++){
      if(canMove(x+dx/steps,z))x+=dx/steps;
      if(canMove(x,z+dz/steps))z+=dz/steps;
    }
    walkTime+=dt;
  }
  const bob=length&&!input.reducedMotion?WALK.bob*Math.sin(walkTime*WALK.bobRate):0;
  return {...(world.navigation?{groundY}:{}),x,z,y:groundY+(world.eyeHeight??WALK.eyeHeight)+bob,yaw,pitch,walkTime};
}
