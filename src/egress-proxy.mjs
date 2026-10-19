import http from 'node:http';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import {pathToFileURL} from 'node:url';
export function createEgressProxy({connect=net.connect,resolve=lookup,onDenied=()=>{},host='api.anthropic.com'}={}){
  const sockets=new Set();
  const server=http.createServer((req,res)=>{res.writeHead(403);res.end();});
  server.on('connect',async(req,client,head)=>{
    if(req.url!==host+':443'||sockets.size>32){onDenied(/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(req.url||'')?req.url.split(':')[0]:'invalid-host');client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    let upstream;
    const close=()=>{client.destroy();upstream?.destroy();};
    client.setTimeout(60_000,close);client.on('error',close);
    try{
      const address=await resolve(host,{family:4});
      if(!net.isIPv4(address.address)||/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|224\.|240\.)/.test(address.address))throw new Error('Unsafe DNS');
      if(client.destroyed)return;
      upstream=connect({host:address.address,port:443});
      upstream.setTimeout(60_000,close);upstream.on('error',close);upstream.on('close',()=>client.destroy());client.on('close',()=>upstream.destroy());
      upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
    }catch{close();}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.headersTimeout=10_000;server.requestTimeout=10_000;
  server.stop=()=>{for(const socket of sockets)socket.destroy();server.close();};
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createEgressProxy({onDenied:host=>console.error(JSON.stringify({event:'egress_denied',host}))});
  server.listen(8080,'0.0.0.0',()=>console.log('ready'));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.stop());
}
