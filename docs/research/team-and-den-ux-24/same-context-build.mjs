import {fileURLToPath} from 'node:url';
const observer=fileURLToPath(new URL('./same-context-observer.mjs',import.meta.url));
export function sameContextTransform(code,id){
 const replace=(before,after)=>{if(code.split(before).length!==2)throw Error('Expected one observation seam: '+before);code=code.replace(before,after);};
 if(id.endsWith('/scene/meshy/world.mjs')){
  code=`import {createSameContextBaoObserver} from ${JSON.stringify(observer)};\nimport {createLeisureGesture} from './leisure-gesture.mjs';\n`+code;
  replace('meeting,appearances,disposed=false','meeting,appearances,originalAppearances,disposed=false');
  replace('appearances?.dispose();','den.__bao24Observer?.dispose();originalAppearances?.dispose();appearances?.dispose();');
  replace('den.pandaRigs=appearances.instances;','den.pandaRigs=new Map(appearances.instances);');
  replace('den.createPanda=appearances.createPanda;','den.createPanda=(...args)=>{const panda=appearances.createPanda(...args);den.pandaRigs.set(panda.model,appearances.instances.get(panda.model));return panda;};');
  replace('den.destroyPanda=appearances.destroyPanda;',`den.destroyPanda=model=>{appearances.destroyPanda(model);den.pandaRigs.delete(model);};
  const originalCharacters={...characters};delete originalCharacters.bao;
  originalAppearances=createPandaAppearanceFactory({body,vest,scarf,headphones,securityVest,characters:originalCharacters});resources.add(originalAppearances.outfits);
  den.__bao24Install=(agents,reducedMotion)=>{if(den.__bao24Observer)throw Error('Observer already installed');const original=originalAppearances.createPanda('orchestrator',{runtime:'claude'});return den.__bao24Observer=createSameContextBaoObserver({den,agents,original,createGesture:createLeisureGesture,reducedMotion});};`);
 }else if(id.endsWith('/scene/meshy/actors.mjs')){
  replace('return {actors,applyLive,','return {__bao24State:()=>({time,held,selected}),actors,applyLive,');
 }else if(id.endsWith('/scene/meshy/MeshyDen.jsx')){
  replace("const agents=createMeshyActors(d),media=matchMedia('(prefers-reduced-motion: reduce)');","const agents=createMeshyActors(d),media=matchMedia('(prefers-reduced-motion: reduce)');d.__bao24Install(agents,()=>media.matches);");
  replace('onReady(d);','onReady(d);globalThis.__cast22Attach?.({den:d,agents,scene,renderer:gl,stage});');
 }else if(id.endsWith('/src/App.jsx')){
  replace('const [den,setDen]=useState(null);','const [den,setDen]=useState(null);globalThis.__cast22Camera=camera;');
 }else if(id.endsWith('/src/main.jsx')){
  replace('createRoot(document.getElementById("root")).render(<App />);','let root;globalThis.__baoMount=()=>{root=createRoot(document.getElementById("root"));root.render(<App />);};globalThis.__baoUnmount=()=>root.unmount();globalThis.__baoMount();');
 }else return null;
 return code;
}
