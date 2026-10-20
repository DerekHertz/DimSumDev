// Observation-only acceptance build; no production source edits, bridge writes,
// installed service changes, or rasterisation shortcuts.
import {build} from 'vite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const out='/tmp/den-cast-24-acceptance',port=4425,root=process.cwd();let hooks=0;
await build({configFile:'apps/ui/vite.config.mjs',configLoader:'native',logLevel:'warn',build:{outDir:out,emptyOutDir:true},plugins:[{name:'bao-acceptance-observe',enforce:'pre',transform(code,id){
 if(id.endsWith('/scene/meshy/MeshyDen.jsx')){hooks++;return code.replace('onReady(d);','onReady(d);globalThis.__cast22Attach?.({den:d,agents,scene,renderer:gl,stage});');}
 if(id.endsWith('/src/App.jsx')){hooks++;return code.replace('const [den,setDen]=useState(null);','const [den,setDen]=useState(null);globalThis.__cast22Camera=camera;');}
 if(id.endsWith('/src/main.jsx')){hooks++;return code.replace('createRoot(document.getElementById("root")).render(<App />);','let root;globalThis.__baoMount=()=>{root=createRoot(document.getElementById("root"));root.render(<App />);};globalThis.__baoUnmount=()=>root.unmount();globalThis.__baoMount();');}
 if(id.endsWith('/state/live-store.mjs')){hooks++;return code.replace('listeners.add(fn);','listeners.add(fn);globalThis.__baoSubscriptions=(globalThis.__baoSubscriptions||0)+1;').replace('return () => listeners.delete(fn);','return () => {if(listeners.delete(fn))globalThis.__baoSubscriptions--;};');}
}}]});
if(hooks!==4)throw Error('Missing observation hooks: '+hooks);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const meta={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),instrumentedProductionBuild:true,hooks,port,out};
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1');if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(u.pathname==='/events'&&u.searchParams.has('fixture')){const fixture=JSON.parse(u.searchParams.get('fixture'));res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('event: snapshot\ndata: '+JSON.stringify(fixture)+'\n\n');const timer=setInterval(()=>res.write(': heartbeat\n\n'),1000);req.on('close',()=>clearInterval(timer));return;}
 if(u.pathname==='/__meta'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(meta));return;}
 const file=path.resolve(out,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
 if(!file.startsWith(out+'/')||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res);
});
server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({ready:true,...meta})));
const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);setTimeout(stop,60*60*1000).unref();
