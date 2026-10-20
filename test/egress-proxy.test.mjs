import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {createEgressProxy} from '../src/egress-proxy.mjs';
test('proxy only accepts inference host CONNECT and never resolves denied hosts',async t=>{
  const denied=[],resolved=[];
  const server=createEgressProxy({onDenied:host=>denied.push(host),resolve:async host=>{resolved.push(host);return {address:'127.0.0.1'};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.stop());
  async function send(request){return new Promise((resolve,reject)=>{const socket=net.connect(server.address().port,'127.0.0.1');let data='';socket.setTimeout(2000,()=>socket.destroy(new Error('timeout')));socket.on('connect',()=>socket.end(request));socket.on('data',chunk=>data+=chunk);socket.on('end',()=>resolve(data));socket.on('error',reject);});}
  for(const host of ['github.com:443','example.com:443','api.anthropic.com:80','api.anthropic.com.evil.test:443','127.0.0.1:443'])assert.match(await send(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`),/403 Forbidden/);
  assert.equal(resolved.length,0);assert.equal(denied.length,5);
  assert.match(await send('GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: close\r\n\r\n'),/403 Forbidden/);
  assert.equal(await send('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n'),'');assert.deepEqual(resolved,['api.anthropic.com']);
});
