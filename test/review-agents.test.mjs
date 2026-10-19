import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {loadConfig} from '../src/config.mjs';
import {createServer} from '../src/server.mjs';
import {ApiError} from '../src/errors.mjs';
const agent={name:'general',description:'Review',model:'opus',effort:'high',instructions:'Trace callers',skills:[],timeLimitSeconds:300,maxToolSteps:40};
const body={agent:'general',repository:'example/project',commit:'a'.repeat(40),base:'b'.repeat(40),messages:[{role:'user',content:'Review the changes'}],response_format:{type:'json_schema',json_schema:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}}};
const completed={result:{object:'chat.completion',model:'claude/opus',choices:[{index:0,message:{role:'assistant',content:'{"ok":true}'},finish_reason:'stop'}]},usage:{durationMs:10,toolSteps:2,effort:'high'},warnings:['possible_prompt_injection']};
async function fixture(t,runner=async()=>completed){
  const dir=await mkdtemp(path.join(os.tmpdir(),'review-agents-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const config=await loadConfig({APP_DATA_DIR:dir});config.reviewKey='slice_ci_'+'e'.repeat(64);
  const store=config.reviewStore;await store.saveAgent(agent);await store.saveAgent({...agent,name:'restricted'});
  const first=await store.saveProject({name:'one',repository:'example/project',allowedAgents:['general']});
  const second=await store.saveProject({name:'two',repository:'example/other',allowedAgents:['restricted']});
  const calls=[];
  const server=createServer(config,{complete:async()=> 'legacy',status:async()=>[]},{...(runner===null?{}:{reviewRunner:async(...args)=>{calls.push(args);return runner(...args);}})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.stop();server.closeAllConnections();});
  const url='http://127.0.0.1:'+server.address().port;
  async function request(route='/ci/review',data,key=first.key,extra={}){
    const response=await fetch(url+route,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json',prefer:'respond-async',...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:response.status,location:response.headers.get('location'),body:await response.json()};
  }
  return {request,store,config,first,second,calls,server};
}
test('agent route validates credentials, agent permission, repository and full commit IDs in order',async t=>{
  const {request,first,config,calls}=await fixture(t);
  for(const key of ['bad',config.apiKey,config.reviewKey])assert.equal((await request('/ci/review',body,key)).body.error.code,'unauthorized');
  for(const [change,code] of [[{agent:'missing',repository:'bad',commit:'bad'},'unknown_agent'],[{agent:'restricted',repository:'bad'},'agent_not_allowed'],[{repository:'bad',commit:'bad'},'repository_mismatch'],[{commit:'bad'},'invalid_commit'],[{base:'bad'},'invalid_commit'],[{model:'claude/opus'},'unsupported_review_request'],[{stream:false},'unsupported_review_request'],[{messages:[{role:'assistant',content:'x'}]},'invalid_messages'],[{messages:[{role:'user',content:'x'.repeat(400001)}]},'prompt_too_large']]){
    assert.equal((await request('/ci/review',{...body,...change})).body.error.code,code);
  }
  assert.equal((await request('/ci/review',body,first.key,{prefer:''})).body.error.code,'async_required');
  assert.equal((await request('/ci/review',body,first.key,{origin:''})).body.error.code,'origin_rejected');
  assert.equal((await request('/ci/review',body,first.key,{origin:'https://owner.test'})).status,403);
  assert.equal(calls.length,0);
});
test('jobs expose safe result metadata, isolate projects and legacy keys, and retain submitted settings',async t=>{
  let finish;
  const {request,store,first,second,config,calls}=await fixture(t,()=>new Promise(resolve=>{finish=resolve;}));
  const list=await request('/ci/review?agents');assert.equal(list.body.agents.length,1);assert.equal(list.body.agents[0].name,'general');assert.doesNotMatch(JSON.stringify(list.body),/instructions|skills|keyHash/);
  const submission=await request('/ci/review',body);assert.equal(submission.status,202);assert.equal(submission.body.agent,'general');assert.equal(submission.location,'/ci/review?job='+submission.body.id);
  await tick();assert.equal(calls.length,1);
  await store.saveAgent({...agent,instructions:'New instructions',model:'sonnet'});
  assert.equal(calls[0][0].agent.instructions,'Trace callers');assert.equal(calls[0][0].agent.model,'opus');assert.equal(calls[0][0].base,body.base);assert.deepEqual(calls[0][0].schema,body.response_format.json_schema.schema);
  assert.equal((await request(submission.location,undefined,second.key)).body.error.code,'job_not_found');
  assert.equal((await request('/ci/slice/review?job='+submission.body.id,undefined,config.reviewKey)).body.error.code,'job_not_found');
  finish(completed);await tick();await tick();
  const result=await request(submission.location);assert.equal(result.body.status,'completed');assert.deepEqual(result.body.usage,completed.usage);assert.deepEqual(result.body.result,completed.result);assert.deepEqual(result.body.warnings,completed.warnings);
  assert.doesNotMatch(JSON.stringify(result.body),/keyHash|githubToken|instructions/);
  const rotated=await store.rotateKey('one');assert.equal((await request(submission.location,undefined,first.key)).status,401);assert.equal((await request(submission.location,undefined,rotated.key)).status,404);
});
test('runner failures remain unsuccessful and redact unexpected diagnostics',async t=>{
  let failure=new ApiError(504,'agent_step_limit','The review exceeded its tool limit.');
  const {request}=await fixture(t,async()=>{throw failure;});
  for(const code of ['agent_step_limit','internal_error']){
    const submitted=await request('/ci/review',body);await tick();await tick();const result=await request(submitted.location);
    assert.equal(result.body.status,'failed');assert.equal(result.body.error.code,code);assert.equal(result.body.result,undefined);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);failure=new Error('PRIVATE');
  }
});
test('unconfigured execution fails closed while agent listing remains available',async t=>{
  const {request,calls}=await fixture(t,null);
  assert.equal((await request('/ci/review',body)).body.error.code,'sandbox_unavailable');assert.equal((await request('/ci/review?agents')).status,200);assert.equal(calls.length,0);
});
test('legacy and agent submissions share queue capacity',async t=>{
  const {request,config}=await fixture(t,()=>new Promise(()=>{}));
  const first=await request('/ci/review',body);assert.equal(first.status,202);await tick();
  for(let i=0;i<4;i++)assert.equal((await request('/ci/review',body)).status,202);
  assert.equal((await request('/ci/review',body)).body.error.code,'queue_full');
  assert.equal((await request('/ci/slice/review',{model:'claude/claude-opus-5-5',messages:body.messages},config.reviewKey)).body.error.code,'queue_full');
});
