import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {loadManifest,loadModel,disposeWorld} from '../../src/scene/meshy/assets.mjs';
import {fitRoleAsset} from '../../src/scene/meshy/role-wardrobe.mjs';
import {createPandaAppearanceFactory} from '../../src/scene/meshy/panda-appearance.mjs';
import {GROVE_ROLES} from '../../src/scene/meshy/grove-style.mjs';
import {createLeisureGesture} from '../../src/scene/meshy/leisure-gesture.mjs';

const stage=document.querySelector('#stage'),roleSelect=document.querySelector('#role'),poseSelect=document.querySelector('#pose'),themeSelect=document.querySelector('#theme'),status=document.querySelector('#status');
const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;stage.prepend(renderer.domElement);
const scene=new T.Scene(),camera=new T.PerspectiveCamera(32,1,.05,80),controls=new OrbitControls(camera,renderer.domElement);controls.enablePan=false;controls.maxPolarAngle=Math.PI*.48;controls.minDistance=2;controls.maxDistance=25;
const hemi=new T.HemisphereLight('#fff8e9','#7b8c6f',2.3);scene.add(hemi);
const sun=new T.DirectionalLight('#fff0d4',3);sun.position.set(-4,7,7);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-8;sun.shadow.camera.right=8;sun.shadow.camera.top=8;sun.shadow.camera.bottom=-8;sun.shadow.normalBias=.03;scene.add(sun);
const fill=new T.DirectionalLight('#cbdde7',1.3);fill.position.set(4,3,-3);scene.add(fill);
const floor=new T.Mesh(new T.CircleGeometry(30,64),new T.MeshStandardMaterial({color:'#e5dcc6',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.008;floor.receiveShadow=true;scene.add(floor);
const resources=new T.Group();let factory,pandas=[],gestures=[],role='orchestrator',pose='idle',frame=0,disposed=false;
function resetView(){const scale=role==='orchestrator'?1.35:.68;camera.position.set(0,2.5*scale,10.8*scale);controls.target.set(0,1.7*scale,0);controls.update();}
function setRole(value){
 if(!GROVE_ROLES[value])throw Error('Unknown review role');
 gestures.forEach(g=>g.dispose());for(const p of pandas)factory.destroyPanda(p.model);pandas=[];gestures=[];role=value;roleSelect.value=value;
 for(const [index,runtime]of ['claude','codex'].entries()){
  const p=factory.createPanda(role,{runtime}),s=p.model.scale.x;p.model.position.x=(index?1:-1)*1.78*s;p.model.rotation.y=index?-.12:.12;scene.add(p.model);pandas.push(p);gestures.push(createLeisureGesture(p.rig));
 }
 document.querySelector('#claude-label').textContent=role==='orchestrator'?'Bao · Claude':'Claude · '+role;
 document.querySelector('#codex-label').textContent=role==='orchestrator'?'Jiao · Codex':'Codex · '+role;
 status.textContent='Actual shared rig · '+role+' · both runtime palettes · no live agent actions';resetView();render(0);
}
function setTheme(value){themeSelect.value=value;document.body.classList.toggle('dark',value==='dark');scene.background=new T.Color(value==='dark'?'#243b38':'#f3ecdd');floor.material.color.set(value==='dark'?'#344b44':'#e5dcc6');hemi.intensity=value==='dark'?1.5:2.3;renderer.render(scene,camera);}
const prefersReduced=matchMedia('(prefers-reduced-motion: reduce)');
function setPose(value){pose=value;poseSelect.value=value;cancelAnimationFrame(frame);render(0);if(value!=='reduced'&&!prefersReduced.matches)frame=requestAnimationFrame(animate);}
function render(time){
 const reduced=pose==='reduced'||prefersReduced.matches;
 for(let i=0;i<pandas.length;i++){const p=pandas[i];if(pose==='walk')p.rig.poseWaddle(time,{reducedMotion:reduced});else p.rig.poseIdle(time,{reducedMotion:reduced});gestures[i].pose(pose==='greeting'&&!reduced?'greeting':null,time);}
 renderer.render(scene,camera);
}
let lastFrame=0;
function animate(time){if(disposed)return;if(time-lastFrame>=1000/24){render(time/1000);lastFrame=time;}if(pose!=='reduced'&&!prefersReduced.matches)frame=requestAnimationFrame(animate);}
controls.addEventListener('change',()=>render(0));
prefersReduced.addEventListener('change',()=>setPose(pose));
const resize=new ResizeObserver(()=>{renderer.setSize(stage.clientWidth,stage.clientHeight);camera.aspect=stage.clientWidth/stage.clientHeight;camera.updateProjectionMatrix();renderer.render(scene,camera);});resize.observe(stage);
roleSelect.replaceChildren(...Object.keys(GROVE_ROLES).map(value=>{const o=document.createElement('option');o.value=value;o.textContent=value==='orchestrator'?'Bao / Jiao':value[0].toUpperCase()+value.slice(1);return o;}));
roleSelect.addEventListener('change',()=>setRole(roleSelect.value));poseSelect.addEventListener('change',()=>setPose(poseSelect.value));themeSelect.addEventListener('change',()=>setTheme(themeSelect.value));document.querySelector('#reset').addEventListener('click',resetView);
function dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);resize.disconnect();gestures.forEach(g=>g.dispose());factory?.dispose();disposeWorld(resources);disposeWorld(scene);controls.dispose();renderer.dispose();}
window.addEventListener('pagehide',dispose,{once:true});
window.groveReview={ready:false,setRole,setTheme,setPose,render,dispose,stats:()=>({role,instances:factory?.instances.size,runtimes:pandas.map(p=>p.model.userData.runtime),scales:pandas.map(p=>p.model.scale.x),drawCalls:renderer.info.render.calls,paused:pose==='reduced'||prefersReduced.matches,poses:pandas.map(p=>({head:p.rig.bones.Head.getWorldPosition(new T.Vector3()).toArray(),paw:p.rig.bones.paw_R.getWorldPosition(new T.Vector3()).toArray(),greeting:p.rig.bones.Shoulder_L.rotation.z}))})};
try{
 const manifest=await loadManifest(),sources=[];
 for(const id of ['bao','wardrobe.developer-vest','wardrobe.qa-scarf']){const source=await loadModel(manifest[id].url);sources.push(source);resources.add(source);}
 const [body,vestSource,scarfSource]=sources,vest=fitRoleAsset(vestSource,'developer-vest'),scarf=fitRoleAsset(scarfSource,'qa-scarf');resources.add(vest,scarf);
 factory=createPandaAppearanceFactory({body,vest,scarf});resources.add(factory.outfits);
 const requested=new URLSearchParams(location.search).get('role');setRole(GROVE_ROLES[requested]?requested:'orchestrator');setTheme('light');setPose(prefersReduced.matches?'reduced':'idle');window.groveReview.ready=true;
}catch(error){status.setAttribute('role','alert');status.textContent='Wardrobe preview could not load: '+error.message;dispose();throw error;}
