import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { loadConfig } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { skillZip, crc32 } from '../src/skill-zip.mjs';
const content='---\nname: Inspect\ndescription: Read callers\n---\nFollow imports.';
const agent={name:'general',description:'Review',model:'opus',effort:'high',instructions:'Inspect code',skills:['inspect'],timeLimitSeconds:300,maxToolSteps:40};
const owner={host:'portal.test','x-forwarded-host':'portal.test','x-forwarded-proto':'https','cf-access-authenticated-user-email':'owner@test','content-type':'application/json',origin:'https://portal.test'};
async function fixture(t,broken=false){
  const dir=await mkdtemp(path.join(os.tmpdir(),'review-portal-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let config=await loadConfig({APP_DATA_DIR:dir});
  if(broken){await writeFile(path.join(dir,'review/config.json'),'broken',{mode:0o600});config=await loadConfig({APP_DATA_DIR:dir});}
  Object.assign(config,{host:'portal.test',origin:'https://portal.test',ownerEmail:'owner@test'});
  const server=createServer(config,{status:async()=>[],complete:async()=> 'ok'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.stop();server.closeAllConnections();});
  function request(route,body,headers=owner){return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:body===undefined?'GET':'POST',headers},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });}
  return {request,config};
}
test('review administration requires owner forwarding and exact mutation origin',async t=>{
  const {request,config}=await fixture(t);
  for(const headers of [{authorization:'Bearer '+config.apiKey},{...owner,host:'evil.test'},{...owner,'x-forwarded-host':'evil.test'},{...owner,'cf-access-authenticated-user-email':'stranger@test'}]){
    assert.equal((await request('/api/review/config',undefined,headers)).status,401);
    assert.equal((await request('/api/review/agents',agent,headers)).status,401);
  }
  for(const origin of [undefined,'https://evil.test']){
    const headers={...owner};if(origin)headers.origin=origin;else delete headers.origin;
    assert.equal((await request('/api/review/skills',{id:'inspect',files:{'SKILL.md':content}},headers)).status,403);
  }
  assert.equal((await request('/api/review/config')).status,200);
});
test('owner CRUD never returns stored secrets and enforces references, validation and key rotation',async t=>{
  const {request,config}=await fixture(t);
  const post=(route,body)=>request('/api/review/'+route,body);
  assert.equal((await post('skills',{id:'inspect',files:{'SKILL.md':content}})).status,200);
  assert.equal((await post('agents',agent)).status,200);
  assert.equal((await post('agents',{...agent,model:'--injected'})).status,400);
  const project={name:'cuse',repository:'ichen27/cusesublets',allowedAgents:['general'],githubToken:'private-test-token'};
  const created=await post('projects',project);assert.equal(created.status,200);
  assert.equal(config.reviewStore.authenticate(created.body.key).name,'cuse');
  const view=await request('/api/review/config');
  assert.equal(view.headers['cache-control'],'no-store');assert.doesNotMatch(JSON.stringify(view.body),/private-test-token|keyHash|tokenId|review_[a-f0-9]{64}/);
  assert.equal(view.body.projects[0].hasGitHubToken,true);
  assert.deepEqual((await post('projects',project)).body,{});
  const rotated=await post('projects/rotate-key',{name:'cuse'});assert.equal(config.reviewStore.authenticate(created.body.key),null);assert.ok(config.reviewStore.authenticate(rotated.body.key));
  assert.equal((await post('skills/delete',{id:'inspect'})).status,409);
  assert.equal((await post('agents/delete',{name:'general'})).status,409);
  assert.equal((await post('projects/delete',{name:'cuse',surprise:true})).status,400);
  assert.equal((await post('projects/delete',{name:'cuse'})).status,200);
  assert.equal((await post('agents/delete',{name:'general'})).status,200);
  assert.equal((await post('skills/delete',{id:'inspect'})).status,200);
});
test('invalid review configuration leaves personal routes available',async t=>{
  const {request,config}=await fixture(t,true);
  const response=await request('/api/review/config');assert.equal(response.status,503);assert.equal(response.body.error.code,'review_config_invalid');
  assert.equal((await request('/api/status')).status,200);
  assert.equal((await request('/v1/chat/completions',{model:'claude',messages:[{role:'user',content:'hello'}]},{authorization:'Bearer '+config.apiKey,'content-type':'application/json'})).status,200);
});
function zip(entries){
  const locals=[],centrals=[];let offset=0;
  for(const {name,text=content,mode=0x8000,method=8} of entries){
    const filename=Buffer.from(name),bytes=Buffer.from(text),packed=method===8?deflateRawSync(bytes):bytes,crc=crc32(bytes);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE((mode*65536)>>>0,38);central.writeUInt32LE(offset,42);
    locals.push(local,filename,packed);centrals.push(central,filename);offset+=local.length+filename.length+packed.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
test('ZIP upload accepts wrapped text skills and rejects traversal, links, binaries, bombs and corruption',async t=>{
  const good=zip([{name:'inspect/SKILL.md'},{name:'inspect/references/read.md',text:'hello',method:0}]);
  assert.deepEqual({...skillZip(good.toString('base64'))},{'SKILL.md':content,'references/read.md':'hello'});
  for(const entries of [
    [{name:'../SKILL.md'}],[{name:'/SKILL.md'}],[{name:'SKILL.md',mode:0xa000}],
    [{name:'SKILL.md',text:content+'\u0000'}],[{name:'SKILL.md',text:content+'x'.repeat(1_000_000)}],
    [{name:'SKILL.md'},{name:'SKILL.md'}],[{name:'a/SKILL.md'},{name:'b/other.md'}],
    [{name:'SKILL.md',text:Buffer.from([255,254])}],
  ]) assert.throws(()=>skillZip(zip(entries).toString('base64')),error=>error.code==='invalid_skill_archive');
  const corrupt=Buffer.from(good);corrupt[20]^=255; // local compressed size mismatch is not authoritative with descriptors, but corruption below must reject
  corrupt[40]^=255;
  assert.throws(()=>skillZip(corrupt.toString('base64')));
  const {request}=await fixture(t);
  assert.equal((await request('/api/review/skills',{id:'inspect',zip:good.toString('base64')})).status,200);
  assert.equal((await request('/api/review/skills',{id:'inspect',files:{'SKILL.md':content},zip:good.toString('base64')})).status,400);
});
