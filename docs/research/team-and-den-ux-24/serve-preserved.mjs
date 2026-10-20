// Serve the exact retained acceptance build without recompilation after the pause.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root='/tmp/den-cast-24-acceptance';
const meta={commit:'efbb225f9569abeb269cd052236dac426c4d9af4',instrumentedProductionBuild:true,hooks:4,port:4425,out:root};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1');if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(u.pathname==='/__meta'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(meta));return;}
 if(u.pathname==='/events'&&u.searchParams.has('fixture')){const fixture=JSON.parse(u.searchParams.get('fixture'));res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('event: snapshot\ndata: '+JSON.stringify(fixture)+'\n\n');const timer=setInterval(()=>res.write(': heartbeat\n\n'),1000);req.on('close',()=>clearInterval(timer));return;}
 const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(root+'/')||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res);});
server.listen(4425,'0.0.0.0',()=>console.log(JSON.stringify({ready:true,...meta})));
const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);setTimeout(stop,25*60*1000).unref();
