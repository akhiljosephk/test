'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.pdf':'application/pdf'};
const publicFiles = new Set(['index.html','styles.css','app.js','mockups/MapleDesk-Interactive.html']);
http.createServer((req,res)=>{
  let name;
  try { name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '') || 'index.html'; } catch { res.writeHead(400);res.end('Bad request');return; }
  if(!publicFiles.has(name)){res.writeHead(404);res.end('Not found');return;}
  fs.readFile(path.join(root,name),(err,data)=>{if(err){res.writeHead(500);res.end('Unable to read file');return;}res.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);});
}).listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('MapleDesk demo server listening on port '+(process.env.PORT||3000)));
