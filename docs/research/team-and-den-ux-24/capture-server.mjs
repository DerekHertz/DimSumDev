// Measurement-only production build. Never changes shipped application source or the installed den.
// Run from the ticket worktree: timeout 900s node docs/research/team-and-den-ux-22/baseline-server.mjs
import {build} from 'vite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const out=process.env.OUT||'/tmp/den-cast-24-review';const PORT=+(process.env.PORT||4425);
const root=process.cwd();
let hooked=0;
await build({configFile:'apps/ui/vite.config.mjs',configLoader:'native',logLevel:'warn',build:{outDir:out,emptyOutDir:true},plugins:[{
 name:'ticket-22-observation-only',enforce:'pre',transform(code,id){
  if(id.endsWith('/scene/meshy/MeshyDen.jsx')){if(!code.includes('onReady(d);'))throw Error('World hook changed');hooked++;return code.replace('onReady(d);','onReady(d);globalThis.__cast22Attach?.({den:d,agents,scene,renderer:gl,stage});');}
  if(id.endsWith('/src/App.jsx')){if(!code.includes('const [den,setDen]=useState(null);'))throw Error('Camera hook changed');hooked++;return code.replace('const [den,setDen]=useState(null);','const [den,setDen]=useState(null);globalThis.__cast22Camera=camera;');}
 }
}]});
if(hooked!==2)throw Error('Missing instrumentation hooks');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm'};
const server=http.createServer((req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/__meta'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),instrumentedProductionBuild:true,port:PORT}));return;}
 const file=path.resolve(out,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
 if(!file.startsWith(out+'/')){res.writeHead(403);res.end();return;}
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');
 res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res);
});
server.listen(PORT,'0.0.0.0',()=>console.log(JSON.stringify({ready:true,url:'http://127.0.0.1:'+PORT,out,hooks:hooked})));
const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);setTimeout(stop,150*60*1000).unref();
