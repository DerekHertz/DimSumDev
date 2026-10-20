// Temporary dual-family diagnostic build. Different directory from immutable
// acceptance build; no production source or installed service is changed.
import {build} from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {sameContextTransform} from './same-context-build.mjs';
const out='/tmp/den-cast-24-same-context',port=4425,hooks=new Set();
const retained=process.argv.includes('--serve-retained');
let meta;
if(retained){
 const receipt=JSON.parse(fs.readFileSync(new URL('./same-context-receipt.json',import.meta.url)));
 for(const file of receipt.buildFiles){const bytes=fs.readFileSync(out+'/'+file.name);if(bytes.length!==file.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Retained build drift: '+file.name);}
 meta=JSON.parse(fs.readFileSync(out+'/observer-meta.json'));
}else{
await build({configFile:'apps/ui/vite.config.mjs',configLoader:'native',logLevel:'warn',build:{outDir:out,emptyOutDir:true},plugins:[{name:'bao-same-context-observer',enforce:'pre',transform(code,id){const result=sameContextTransform(code,id);if(result!==null)hooks.add(id);return result;}}]});
if(hooks.size!==5)throw Error('Missing observation hooks: '+hooks.size);
meta={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),kind:'Temporary same-context feasibility observer; not normal resource acceptance',hooks:[...hooks],out,port};
fs.writeFileSync(out+'/observer-meta.json',JSON.stringify(meta,null,2)+'\n');
}
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1');if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(u.pathname==='/events'&&u.searchParams.has('fixture')){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('event: snapshot\ndata: '+JSON.stringify(JSON.parse(u.searchParams.get('fixture')))+'\n\n');const timer=setInterval(()=>res.write(': heartbeat\n\n'),1000);req.on('close',()=>clearInterval(timer));return;}
 if(u.pathname==='/__meta'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(meta));return;}
 const file=path.resolve(out,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(out+'/')||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res);
});
server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({ready:true,...meta})));
const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);setTimeout(stop,15*60*1000).unref();
